import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	type Client,
	ClientSideConnection,
	type ContentBlock,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type InitializeResponse,
	type McpServer,
	ndJsonStream,
	PROTOCOL_VERSION,
	type SessionConfigOption,
	type SessionModeState,
	type SessionUpdate,
	type ToolCallContent,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { readProjectMcpFile } from "../lib/projectMcp";
import type {
	AgentEvent,
	AgentProvider,
	AgentQueryParams,
	AgentSession,
	McpServerStatus,
	ProviderModelInfo,
	SlashCommand,
} from "./agentProvider";

export type AcpProviderOptions = {
	id: string;
	label: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
};

type QueueResult<T> = IteratorResult<T>;

type AcpUsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	reported: boolean;
};

class AsyncEventQueue<T> {
	private values: T[] = [];
	private waiters: Array<{
		resolve: (value: QueueResult<T>) => void;
		reject: (error: unknown) => void;
	}> = [];
	private ended = false;
	private error: unknown;

	push(value: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve({ value, done: false });
		else this.values.push(value);
	}

	end(error?: unknown): void {
		if (this.ended) return;
		this.ended = true;
		this.error = error;
		for (const waiter of this.waiters.splice(0)) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined as T, done: true });
		}
	}

	async next(): Promise<QueueResult<T>> {
		const value = this.values.shift();
		if (value !== undefined) return { value, done: false };
		if (this.ended) {
			if (this.error) throw this.error;
			return { value: undefined as T, done: true };
		}
		return new Promise((resolve, reject) =>
			this.waiters.push({ resolve, reject }),
		);
	}
}

function textFromContent(content: ContentBlock): string | null {
	return content.type === "text" ? content.text : null;
}

function json(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function toolContentText(
	content: ToolCallContent[] | null | undefined,
): string {
	if (!content?.length) return "";
	return content
		.map((item) => {
			if (item.type === "content") {
				return textFromContent(item.content) ?? json(item.content);
			}
			if (item.type === "diff") {
				return [
					`File: ${item.path}`,
					...(item.oldText != null ? ["--- before", item.oldText] : []),
					"+++ after",
					item.newText,
				].join("\n");
			}
			return `Terminal: ${item.terminalId}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

function toolResultText(update: ToolCallUpdate): string {
	if (typeof update.rawOutput === "string") return update.rawOutput;
	if (update.rawOutput != null) return json(update.rawOutput);
	return toolContentText(update.content) || "";
}

function planEntriesText(
	entries: Array<{ content: string; status: string }>,
): string {
	return entries
		.map(
			(entry) =>
				`${entry.status === "completed" ? "- [x]" : "- [ ]"} ${entry.content}`,
		)
		.join("\n");
}

function planUpdateText(
	update: Extract<SessionUpdate, { sessionUpdate: "plan_update" }>,
): string {
	if (update.plan.type === "markdown") return update.plan.content;
	if (update.plan.type === "file") return `Plan document: ${update.plan.uri}`;
	return planEntriesText(update.plan.entries);
}

function eventsFromUpdate(
	update: SessionUpdate,
	planEventId?: string,
): AgentEvent[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textFromContent(update.content);
			return text == null ? [] : [{ type: "text_delta", text }];
		}
		case "agent_thought_chunk": {
			const text = textFromContent(update.content);
			return text == null ? [] : [{ type: "summary", text }];
		}
		case "tool_call":
			return [
				{
					type: "tool_start",
					toolId: update.toolCallId,
					name: update.title,
					input: update.rawInput ?? null,
				},
				...(update.status === "completed" || update.status === "failed"
					? [
							{
								type: "tool_result" as const,
								toolId: update.toolCallId,
								content: toolResultText(update),
								isError: update.status === "failed",
							},
						]
					: []),
			];
		case "tool_call_update":
			if (update.status !== "completed" && update.status !== "failed")
				return [];
			return [
				{
					type: "tool_result",
					toolId: update.toolCallId,
					content: toolResultText(update),
					isError: update.status === "failed",
				},
			];
		case "plan": {
			const toolId = planEventId ?? "acp-plan";
			return [
				{
					type: "tool_start",
					toolId,
					name: "UpdatePlan",
					input: { plan: update.entries },
				},
				{
					type: "tool_result",
					toolId,
					content: planEntriesText(update.entries),
				},
			];
		}
		case "plan_update": {
			const toolId = planEventId ?? `acp-plan-${update.plan.id}`;
			return [
				{ type: "tool_start", toolId, name: "UpdatePlan", input: update.plan },
				{ type: "tool_result", toolId, content: planUpdateText(update) },
			];
		}
		case "plan_removed": {
			const toolId = planEventId ?? `acp-plan-${update.id}-removed`;
			return [
				{
					type: "tool_start",
					toolId,
					name: "UpdatePlan",
					input: { id: update.id, removed: true },
				},
				{ type: "tool_result", toolId, content: "Plan removed" },
			];
		}
		case "usage_update":
			return [
				{
					type: "usage",
					inputTokens: 0,
					outputTokens: 0,
					contextTokens: update.used,
					contextWindow: update.size,
				},
			];
		default:
			return [];
	}
}

function planModeId(modes: SessionModeState | null | undefined): string | null {
	if (!modes) return null;
	const exact = modes.availableModes.find((mode) =>
		[mode.id, mode.name].some((value) => value.toLowerCase() === "plan"),
	);
	if (exact) return exact.id;
	const architectural = modes.availableModes.find((mode) =>
		[mode.id, mode.name].some((value) => /architect|planning/i.test(value)),
	);
	return architectural?.id ?? null;
}

function filePathFromToolInput(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	for (const key of ["file_path", "filePath", "path"]) {
		if (typeof input[key] === "string") return input[key];
	}
	return null;
}

function isHtmlPlanPath(path: string): boolean {
	return /(?:^|[\\/])\.hlid[\\/]plans[\\/]plan-[^\\/]+\.html$/i.test(path);
}

function acpToolName(toolCall: ToolCallUpdate): string {
	switch (toolCall.kind) {
		case "read":
			return "Read";
		case "edit":
		case "delete":
		case "move":
			return "Write";
		case "search":
			return "Grep";
		case "execute":
			return "Bash";
		case "think":
			return "Reasoning";
		case "fetch":
			return "WebFetch";
		case "switch_mode":
			return toolCall.title ?? "SwitchMode";
		default:
			return toolCall.title ?? "ACP tool";
	}
}

function acpToolInput(toolCall: ToolCallUpdate): unknown {
	const raw = toolCall.rawInput;
	const filePath = filePathFromToolInput(raw);
	if (!filePath || acpToolName(toolCall) !== "Write") return raw ?? null;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return { ...(raw as Record<string, unknown>), file_path: filePath };
	}
	return { file_path: filePath };
}

function headers(value: unknown): Array<{ name: string; value: string }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value).flatMap(([name, header]) =>
		typeof header === "string" ? [{ name, value: header }] : [],
	);
}

function configuredMcpServers(cwd: string): {
	servers: McpServer[];
	statuses: McpServerStatus[];
} {
	try {
		const entries = readProjectMcpFile(cwd).servers;
		const servers: McpServer[] = [];
		const statuses: McpServerStatus[] = [];
		for (const entry of entries) {
			if (entry.disabled) {
				statuses.push({
					name: entry.name,
					status: "disabled",
					scope: "project",
				});
				continue;
			}
			const config =
				entry.config &&
				typeof entry.config === "object" &&
				!Array.isArray(entry.config)
					? (entry.config as Record<string, unknown>)
					: {};
			if (typeof config.command === "string") {
				servers.push({
					name: entry.name,
					command: config.command,
					args: Array.isArray(config.args)
						? config.args.filter(
								(arg): arg is string => typeof arg === "string",
							)
						: [],
					env:
						config.env &&
						typeof config.env === "object" &&
						!Array.isArray(config.env)
							? Object.entries(config.env).flatMap(([name, value]) =>
									typeof value === "string" ? [{ name, value }] : [],
								)
							: [],
				});
				statuses.push({
					name: entry.name,
					status: "pending",
					scope: "project",
				});
				continue;
			}
			if (typeof config.url === "string") {
				servers.push({
					type: config.type === "sse" ? "sse" : "http",
					name: entry.name,
					url: config.url,
					headers: headers(config.headers),
				});
				statuses.push({
					name: entry.name,
					status: "pending",
					scope: "project",
				});
				continue;
			}
			statuses.push({
				name: entry.name,
				status: "failed",
				scope: "project",
				error: "Unsupported MCP configuration",
			});
		}
		return { servers, statuses };
	} catch (error) {
		return {
			servers: [],
			statuses: [
				{
					name: ".mcp.json",
					status: "failed",
					scope: "project",
					error: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

function selectOptions(option: SessionConfigOption): ProviderModelInfo[] {
	if (option.type !== "select") return [];
	return option.options.flatMap((item) =>
		"group" in item
			? item.options.map((nested) => ({
					value: nested.value,
					label: nested.name,
					description: nested.description ?? undefined,
					isDefault: nested.value === option.currentValue,
				}))
			: [
					{
						value: item.value,
						label: item.name,
						description: item.description ?? undefined,
						isDefault: item.value === option.currentValue,
					},
				],
	);
}

function configOption(
	options: SessionConfigOption[],
	category: string,
	namePattern: RegExp,
): SessionConfigOption | undefined {
	return (
		options.find((option) => option.category === category) ??
		options.find((option) => namePattern.test(`${option.id} ${option.name}`))
	);
}

type ElicitationField = {
	key: string;
	question: string;
	type: "string" | "number" | "integer" | "boolean" | "array";
	values: Map<string, string>;
	freeText: boolean;
	placeholder?: string;
};

function elicitationFields(
	request: CreateElicitationRequest,
): ElicitationField[] {
	if (request.mode !== "form") return [];
	const properties = request.requestedSchema.properties ?? {};
	return Object.entries(properties).map(([key, property]) => {
		const question = property.title?.trim() || key;
		const values = new Map<string, string>();
		if (property.type === "string") {
			for (const value of property.enum ?? []) values.set(value, value);
			for (const item of property.oneOf ?? [])
				values.set(item.title, item.const);
		} else if (property.type === "array") {
			if ("enum" in property.items) {
				for (const value of property.items.enum) values.set(value, value);
			} else {
				for (const item of property.items.anyOf)
					values.set(item.title, item.const);
			}
		} else if (property.type === "boolean") {
			values.set("Yes", "true");
			values.set("No", "false");
		}
		return {
			key,
			question,
			type: property.type,
			values,
			freeText: values.size === 0,
			placeholder: property.description ?? undefined,
		};
	});
}

function elicitationContent(
	fields: ElicitationField[],
	answers: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> {
	const content: Record<string, string | number | boolean | string[]> = {};
	for (const field of fields) {
		const answer = answers[field.question];
		const raw = typeof answer === "string" ? answer : "";
		const [selectionText, note = ""] = raw.split("\n\nNotes:", 2);
		const selections = selectionText ? selectionText.split(", ") : [];
		const mapped = selections.map(
			(selection) => field.values.get(selection) ?? selection,
		);
		const freeValue = note.trim() || mapped.find((value) => value) || "";
		if (field.type === "array") content[field.key] = mapped.filter(Boolean);
		else if (field.type === "boolean")
			content[field.key] = freeValue === "true";
		else if (field.type === "number" || field.type === "integer") {
			const number = Number(freeValue);
			if (Number.isFinite(number)) content[field.key] = number;
		} else content[field.key] = freeValue;
	}
	return content;
}

class AcpSession implements AgentSession {
	private readonly events = new AsyncEventQueue<AgentEvent>();
	private process: ChildProcessWithoutNullStreams | null = null;
	private connection: ClientSideConnection | null = null;
	private sessionId: string | null = null;
	private initPromise: Promise<void> | null = null;
	private cancelled = false;
	private turns = 0;
	private commands: SlashCommand[] = [];
	private closeAfterTurn = false;
	private canDeleteSession = false;
	private canCloseSession = false;
	private modes: SessionModeState | null = null;
	private configOptions: SessionConfigOption[] = [];
	private implementationModeId: string | null = null;
	private approvedHtmlPlanToolIds = new Set<string>();
	private htmlPlanReady = false;
	private nativePlanText = "";
	private turnText = "";
	private planEventSeq = 0;
	private elicitationSeq = 0;
	private latestCostUsd: number | null = null;
	private turnStartCostUsd: number | null = null;
	private mcpServers: McpServer[] = [];
	private mcpStatuses: McpServerStatus[] = [];

	constructor(
		private readonly options: AcpProviderOptions,
		private readonly params: AgentQueryParams,
	) {
		const mcp = configuredMcpServers(params.cwd);
		this.mcpServers = mcp.servers;
		this.mcpStatuses = mcp.statuses;
		params.signal?.addEventListener("abort", () => this.cancel(), {
			once: true,
		});
	}

	private async handleElicitation(
		request: CreateElicitationRequest,
	): Promise<CreateElicitationResponse> {
		if (request.mode !== "form") return { action: "decline" };
		const fields = elicitationFields(request);
		if (fields.length === 0) return { action: "decline" };
		const questions = fields.map((field) => ({
			question: field.question,
			options: [...field.values.keys()],
			multiSelect: field.type === "array",
			...(field.freeText ? { freeText: true } : {}),
			...(field.type === "number" || field.type === "integer"
				? { inputType: "number" as const }
				: {}),
			...(field.placeholder ? { placeholder: field.placeholder } : {}),
		}));
		const toolUseID =
			("toolCallId" in request && request.toolCallId) ||
			`acp-elicitation-${this.sessionId ?? "request"}-${++this.elicitationSeq}`;
		const decision = await this.params.canUseTool(
			"AskUserQuestion",
			{ questions },
			{
				toolUseID,
				signal: this.params.signal ?? new AbortController().signal,
				title: request.message,
				displayName: "elicitation/create",
			},
		);
		if (decision.behavior !== "allow") return { action: "decline" };
		const updated =
			decision.updatedInput && typeof decision.updatedInput === "object"
				? (decision.updatedInput as Record<string, unknown>)
				: {};
		const answers =
			updated.answers && typeof updated.answers === "object"
				? (updated.answers as Record<string, unknown>)
				: {};
		return { action: "accept", content: elicitationContent(fields, answers) };
	}

	private async setConfigValue(
		category: "model" | "thought_level",
		value: string | undefined,
	): Promise<void> {
		if (!value || !this.connection || !this.sessionId) return;
		const option = configOption(
			this.configOptions,
			category,
			category === "model" ? /model/i : /thought|reason|effort/i,
		);
		if (!option || option.type !== "select") return;
		const response = await this.connection.setSessionConfigOption({
			sessionId: this.sessionId,
			configId: option.id,
			value,
		});
		this.configOptions = response.configOptions;
	}

	private async syncPermissionMode(mode: string): Promise<void> {
		if (!this.connection || !this.sessionId || !this.modes) return;
		const planningModeId = planModeId(this.modes);
		if (mode === "plan") {
			if (!planningModeId) return;
			if (this.modes.currentModeId !== planningModeId) {
				this.implementationModeId = this.modes.currentModeId;
				await this.connection.setSessionMode({
					sessionId: this.sessionId,
					modeId: planningModeId,
				});
				this.modes = { ...this.modes, currentModeId: planningModeId };
			}
			return;
		}
		if (
			planningModeId &&
			this.modes.currentModeId === planningModeId &&
			this.implementationModeId
		) {
			await this.connection.setSessionMode({
				sessionId: this.sessionId,
				modeId: this.implementationModeId,
			});
			this.modes = { ...this.modes, currentModeId: this.implementationModeId };
		}
	}

	private initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.doInitialize();
		return this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		if (this.cancelled) return;
		const child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.params.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.process = child;
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-8_000);
		});
		child.once("error", (error) => this.events.end(error));
		child.once("exit", (code) => {
			if (!this.cancelled && code !== 0) {
				this.events.end(
					new Error(stderr.trim() || `ACP agent exited with code ${code}`),
				);
			}
		});

		const client: Client = {
			requestPermission: async ({ toolCall, options }) => {
				const filePath = filePathFromToolInput(toolCall.rawInput);
				const toolName = acpToolName(toolCall);
				const toolInput = acpToolInput(toolCall);
				const decision =
					this.params.permissionMode === "bypassPermissions" &&
					!this.params.policyEnforced
						? { behavior: "allow" as const }
						: await this.params.canUseTool(toolName, toolInput, {
								toolUseID: toolCall.toolCallId,
								signal: this.params.signal ?? new AbortController().signal,
								title: toolCall.title ?? undefined,
							});
				const allowed = decision.behavior === "allow";
				if (
					allowed &&
					this.params.permissionMode === "plan" &&
					toolName === "Write" &&
					filePath &&
					isHtmlPlanPath(filePath)
				) {
					this.approvedHtmlPlanToolIds.add(toolCall.toolCallId);
				}
				const option = options.find((item) =>
					allowed
						? item.kind.startsWith("allow")
						: item.kind.startsWith("reject"),
				);
				return option
					? { outcome: { outcome: "selected", optionId: option.optionId } }
					: { outcome: { outcome: "cancelled" } };
			},
			unstable_createElicitation: async (request) => {
				try {
					return await this.handleElicitation(request);
				} catch (error) {
					console.error("[acp] elicitation failed:", error);
					throw error;
				}
			},
			sessionUpdate: ({ update }) => {
				if (update.sessionUpdate === "agent_message_chunk") {
					this.turnText += textFromContent(update.content) ?? "";
				}
				if (update.sessionUpdate === "available_commands_update") {
					this.commands = update.availableCommands.map((command) => ({
						name: command.name,
						description: command.description ?? "",
						argumentHint: command.input?.hint ?? "",
					}));
				}
				if (
					update.sessionUpdate === "tool_call_update" &&
					update.status === "completed" &&
					this.approvedHtmlPlanToolIds.has(update.toolCallId)
				) {
					this.htmlPlanReady = true;
				}
				if (update.sessionUpdate === "current_mode_update" && this.modes) {
					this.modes = { ...this.modes, currentModeId: update.currentModeId };
				}
				if (update.sessionUpdate === "config_option_update") {
					this.configOptions = update.configOptions;
				}
				if (update.sessionUpdate === "plan") {
					this.nativePlanText = planEntriesText(update.entries);
				}
				if (update.sessionUpdate === "plan_update") {
					this.nativePlanText = planUpdateText(update);
				}
				if (update.sessionUpdate === "plan_removed") {
					this.nativePlanText = "";
				}
				if (
					update.sessionUpdate === "usage_update" &&
					update.cost?.currency.toUpperCase() === "USD"
				) {
					this.latestCostUsd = update.cost.amount;
				}
				const planEventId =
					update.sessionUpdate === "plan" ||
					update.sessionUpdate === "plan_update" ||
					update.sessionUpdate === "plan_removed"
						? `acp-plan-${++this.planEventSeq}`
						: undefined;
				for (const event of eventsFromUpdate(update, planEventId)) {
					this.events.push(event);
				}
			},
		};
		const stream = ndJsonStream(
			Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		);
		const connection = new ClientSideConnection(() => client, stream);
		this.connection = connection;
		const initialized = await connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { plan: {}, elicitation: { form: {} } },
			clientInfo: { name: "Hlid", version: "1" },
		});
		this.canDeleteSession = Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.delete,
		);
		this.canCloseSession = Boolean(
			initialized.agentCapabilities?.sessionCapabilities?.close,
		);
		if (this.cancelled) return;
		let modes: SessionModeState | null | undefined;
		let configOptions: SessionConfigOption[] | null | undefined;
		if (this.params.sessionId && initialized.agentCapabilities?.loadSession) {
			const loaded = await connection.loadSession({
				sessionId: this.params.sessionId,
				cwd: this.params.cwd,
				additionalDirectories: this.params.additionalDirectories,
				mcpServers: this.mcpServers,
			});
			modes = loaded.modes;
			configOptions = loaded.configOptions;
			this.sessionId = this.params.sessionId;
		} else {
			const created = await connection.newSession({
				cwd: this.params.cwd,
				additionalDirectories: this.params.additionalDirectories,
				mcpServers: this.mcpServers,
			});
			this.sessionId = created.sessionId;
			modes = created.modes;
			configOptions = created.configOptions;
		}
		this.modes = modes ?? null;
		this.configOptions = configOptions ?? [];
		const planningModeId = planModeId(this.modes);
		if (planningModeId && this.modes?.currentModeId === planningModeId) {
			this.implementationModeId =
				this.modes.availableModes.find((mode) => mode.id !== planningModeId)
					?.id ?? null;
		}
		await this.setConfigValue("model", this.params.model);
		await this.setConfigValue("thought_level", this.params.effort);
		await this.syncPermissionMode(this.params.permissionMode ?? "default");
		this.events.push({ type: "session_start", sessionId: this.sessionId });
	}

	async send(message: string): Promise<void> {
		await this.initialize();
		if (this.cancelled || !this.connection || !this.sessionId) return;
		void this.runPrompt(message).catch((error) => this.events.end(error));
	}

	private async runPrompt(
		message: string,
		costStartUsd: number | null = this.latestCostUsd,
		queryTurnStart = this.turns,
		queryStartedMs = Date.now(),
		queryUsage: AcpUsageTotals = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			reported: false,
		},
	): Promise<void> {
		if (!this.connection || !this.sessionId) return;
		this.approvedHtmlPlanToolIds.clear();
		this.htmlPlanReady = false;
		this.nativePlanText = "";
		this.turnText = "";
		this.turnStartCostUsd = costStartUsd;
		const response = await this.connection.prompt({
			sessionId: this.sessionId,
			prompt: [{ type: "text", text: message }],
		});
		this.turns += 1;
		if (response.usage) {
			queryUsage.inputTokens += response.usage.inputTokens;
			queryUsage.outputTokens += response.usage.outputTokens;
			queryUsage.cacheReadTokens += response.usage.cachedReadTokens ?? 0;
			queryUsage.cacheCreationTokens += response.usage.cachedWriteTokens ?? 0;
			queryUsage.reported = true;
			this.events.push({
				type: "usage",
				inputTokens: response.usage.inputTokens,
				outputTokens: response.usage.outputTokens,
				cacheReadTokens: response.usage.cachedReadTokens ?? undefined,
				cacheCreationTokens: response.usage.cachedWriteTokens ?? undefined,
			});
		}
		if (this.params.permissionMode === "plan") {
			const plan =
				this.nativePlanText ||
				(this.htmlPlanReady || this.params.planHtmlPath
					? "HTML plan ready for review."
					: this.turnText.trim() ||
						`${this.options.label} completed its plan.`);
			const decision = await this.params.canUseTool(
				"ExitPlanMode",
				{ plan },
				{
					toolUseID: `acp-plan-${this.sessionId}-${this.turns}`,
					signal: this.params.signal ?? new AbortController().signal,
					title: `${this.options.label} completed its plan`,
				},
			);
			if (
				decision.behavior === "deny" &&
				decision.message?.startsWith("User requested changes to the plan:")
			) {
				await this.runPrompt(
					`${decision.message}\n\nRevise the plan accordingly. Replace the HTML plan document specified earlier and present it for approval again.`,
					costStartUsd,
					queryTurnStart,
					queryStartedMs,
					queryUsage,
				);
				return;
			}
			if (decision.behavior === "allow") {
				this.params.permissionMode =
					this.params.implementationPermissionMode ?? "default";
				await this.syncPermissionMode(this.params.permissionMode);
				await this.runPrompt(
					"The user approved the plan. Implement it now, including its validation steps. Do not create another plan unless implementation reveals a material blocker that requires user input.",
					costStartUsd,
					queryTurnStart,
					queryStartedMs,
					queryUsage,
				);
				return;
			}
		}
		this.events.push({
			type: "done",
			...(this.latestCostUsd != null
				? {
						cost: Math.max(
							0,
							this.latestCostUsd - (this.turnStartCostUsd ?? 0),
						),
					}
				: {}),
			turns: this.turns - queryTurnStart,
			durationMs: Date.now() - queryStartedMs,
			stopReason: response.stopReason,
			...(queryUsage.reported
				? {
						usage: {
							inputTokens: queryUsage.inputTokens,
							outputTokens: queryUsage.outputTokens,
							cacheReadTokens: queryUsage.cacheReadTokens,
							cacheCreationTokens: queryUsage.cacheCreationTokens,
						},
					}
				: {}),
		});
		if (this.closeAfterTurn) await this.finishOneShot();
	}

	cancel(): void {
		if (this.cancelled) return;
		this.cancelled = true;
		if (this.connection && this.sessionId) {
			void this.connection.cancel({ sessionId: this.sessionId });
		}
		this.process?.kill();
		this.events.end();
	}

	async interrupt(): Promise<void> {
		if (this.cancelled || !this.connection || !this.sessionId) return;
		await this.connection.cancel({ sessionId: this.sessionId });
	}

	closeInput(): void {
		this.closeAfterTurn = true;
	}

	private async finishOneShot(): Promise<void> {
		if (this.connection && this.sessionId) {
			if (this.params.persistSession === false && this.canDeleteSession) {
				await this.connection
					.deleteSession({ sessionId: this.sessionId })
					.catch(() => {});
			} else if (this.canCloseSession) {
				await this.connection
					.closeSession({ sessionId: this.sessionId })
					.catch(() => {});
			}
		}
		this.process?.kill();
		this.events.end();
	}

	async mcpServerStatus(): Promise<McpServerStatus[]> {
		return this.mcpStatuses;
	}

	async supportedCommands(): Promise<SlashCommand[]> {
		return this.commands;
	}

	async setPermissionMode(mode: string): Promise<void> {
		if (
			mode === "default" ||
			mode === "acceptEdits" ||
			mode === "bypassPermissions" ||
			mode === "plan"
		) {
			this.params.permissionMode = mode;
			await this.syncPermissionMode(mode);
		}
	}

	async setModel(model?: string): Promise<void> {
		this.params.model = model;
		await this.setConfigValue("model", model);
	}

	async setEffort(effort: string): Promise<void> {
		this.params.effort = effort;
		await this.setConfigValue("thought_level", effort);
	}

	setPlanHtmlPath(path: string | undefined): void {
		this.params.planHtmlPath = path;
	}

	[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
		return { next: () => this.events.next() };
	}
}

export class AcpProvider implements AgentProvider {
	readonly providerId: string;
	readonly label: string;
	readonly permissionModes = [
		{ value: "default", label: "Ask" },
		{ value: "bypassPermissions", label: "Allow all" },
	] as const;

	constructor(readonly options: AcpProviderOptions) {
		this.providerId = options.id;
		this.label = options.label;
	}

	async check(): Promise<{ available: boolean; reason?: string }> {
		const resolved = Bun.which(this.options.command);
		return resolved
			? { available: true }
			: {
					available: false,
					reason: `${this.options.command} is not installed`,
				};
	}

	async listModels(): Promise<ProviderModelInfo[]> {
		const options = await inspectAcpSessionConfig(this.options);
		const model = configOption(options, "model", /model/i);
		if (!model) return [];
		const thought = configOption(
			options,
			"thought_level",
			/thought|reason|effort/i,
		);
		const efforts = (thought ? selectOptions(thought) : []).map((effort) => ({
			value: effort.value,
			label: effort.label,
			desc: effort.description,
			isDefault: effort.isDefault,
		}));
		return selectOptions(model).map((entry) => ({
			...entry,
			...(efforts.length > 0 ? { efforts } : {}),
		}));
	}

	query(params: AgentQueryParams): AgentSession {
		return new AcpSession(this.options, params);
	}
}

function createInspectionConnection(options: AcpProviderOptions): {
	child: ChildProcessWithoutNullStreams;
	connection: ClientSideConnection;
} {
	const child = spawn(options.command, options.args ?? [], {
		cwd: process.cwd(),
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const stream = ndJsonStream(
		Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
		Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
	);
	const connection = new ClientSideConnection(
		() => ({
			requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
			sessionUpdate: () => {},
		}),
		stream,
	);
	return { child, connection };
}

async function inspectAcpSessionConfig(
	options: AcpProviderOptions,
): Promise<SessionConfigOption[]> {
	const { child, connection } = createInspectionConnection(options);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				await connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {},
					clientInfo: { name: "Hlid", version: "1" },
				});
				const created = await connection.newSession({
					cwd: process.cwd(),
					mcpServers: [],
				});
				return created.configOptions ?? [];
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("ACP model inspection timed out")),
					10_000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		child.kill();
	}
}

export async function inspectAcpAgent(
	options: AcpProviderOptions,
	methodId?: string,
): Promise<InitializeResponse> {
	const { child, connection } = createInspectionConnection(options);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const initialized = await connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {},
					clientInfo: { name: "Hlid", version: "1" },
				});
				if (methodId) await connection.authenticate({ methodId });
				return initialized;
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("ACP agent inspection timed out")),
					10_000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		child.kill();
	}
}
