#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const behavior = process.env.HLID_FAKE_ACP_BEHAVIOR ?? "";
const stableModeBehavior = behavior.startsWith("stable-mode");
const dependentConfigBehavior = behavior === "dependent-config";
const supportsResume = ![
	"hang-load",
	"reject-load",
	"load-only-replay",
].includes(behavior);
const never = () => new Promise(() => {});
const stall = async (phase) => {
	process.stderr.write(`fake ${phase} stalled\n`);
	await never();
};
const configOptions = (session) => [
	{
		type: "select",
		id: "model",
		name: "Model",
		category: "model",
		currentValue: session?.model ?? "fake-fast",
		options:
			behavior === "cwd-model"
				? [{ value: session?.model ?? "unknown", name: "Discovery CWD" }]
				: behavior === "model-plan-option"
					? [
							{ value: "code", name: "Code model" },
							{ value: "plan", name: "Planning model" },
						]
					: [
							{ value: "fake-fast", name: "Fake Fast" },
							{ value: "fake-smart", name: "Fake Smart" },
						],
	},
	{
		type: "select",
		id: "thought",
		name: "Reasoning",
		category: "thought_level",
		currentValue: session?.effort ?? "medium",
		options:
			dependentConfigBehavior && session?.model === "fake-smart"
				? [
						{ value: "high", name: "High" },
						{ value: "xhigh", name: "Extra High" },
					]
				: [
						{ value: "low", name: "Low" },
						{ value: "medium", name: "Medium" },
						{ value: "high", name: "High" },
					],
	},
	...(stableModeBehavior || dependentConfigBehavior
		? [
				{
					type: "select",
					id: "mode",
					name: "Mode",
					category: "mode",
					currentValue:
						session?.mode ??
						(behavior === "stable-mode-start-plan" ? "plan" : "default"),
					options:
						dependentConfigBehavior && session?.model === "fake-smart"
							? [
									{ value: "build", name: "Build" },
									{ value: "plan", name: "Plan" },
									{ value: "review", name: "Review" },
								]
							: behavior === "stable-mode-start-plan"
								? [
										{ value: "ask", name: "Ask" },
										{ value: "architect", name: "Architect" },
										{ value: "plan", name: "Plan" },
										{ value: "code", name: "Code" },
									]
								: [
										{ value: "default", name: "Default" },
										{ value: "plan", name: "Plan" },
									],
				},
			]
		: []),
];
const modes = (session) => ({
	currentModeId: session.mode,
	availableModes: [
		{ id: "code", name: "Code" },
		{ id: "plan", name: "Plan" },
	],
});
const sessionMetadata = (session) => ({
	...(stableModeBehavior ? {} : { modes: modes(session) }),
	configOptions: configOptions(session),
});
const validateSessionInputs = (params) => {
	if (behavior !== "strict-capabilities") return;
	if (params.additionalDirectories !== undefined) {
		throw new Error("fake agent received unsupported additionalDirectories");
	}
	const unsupportedMcp = params.mcpServers.find(
		(server) => server.type === "http" || server.type === "sse",
	);
	if (unsupportedMcp) {
		throw new Error(
			`fake agent received unsupported ${unsupportedMcp.type} MCP transport`,
		);
	}
};
const notifyThought = (client, sessionId, text, messageId = "thought-a") =>
	client.notify(methods.client.session.update, {
		sessionId,
		update: {
			sessionUpdate: "agent_thought_chunk",
			messageId,
			content: { type: "text", text },
		},
	});
const stream = ndJsonStream(
	Writable.toWeb(process.stdout),
	Readable.toWeb(process.stdin),
);

agent({ name: "hlid-fake-agent" })
	.onRequest("initialize", async () => {
		if (behavior === "hang-initialize") await stall("initialize");
		if (process.env.HLID_FAKE_ACP_INITIALIZE_MARKER) {
			appendFileSync(
				process.env.HLID_FAKE_ACP_INITIALIZE_MARKER,
				"initialize\n",
			);
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				...(behavior === "resume-only" ? {} : { loadSession: true }),
				mcpCapabilities:
					behavior === "strict-capabilities" ? {} : { http: true, sse: true },
				sessionCapabilities: {
					fork: {},
					delete: {},
					close: {},
					...(supportsResume ? { resume: {} } : {}),
					...(behavior === "strict-capabilities"
						? {}
						: { additionalDirectories: {} }),
				},
			},
			authMethods: [{ id: "fake-login", name: "Fake login" }],
			agentInfo: { name: "fake-acp", version: "1.0.0" },
		};
	})
	.onRequest("authenticate", async () => {
		if (behavior === "hang-authenticate") await stall("authentication");
		return {};
	})
	.onRequest("session/new", async ({ params }) => {
		if (behavior === "hang-new") await stall("session creation");
		validateSessionInputs(params);
		const sessionId = "fake-session";
		const session = {
			cancelled: false,
			mode:
				behavior === "stable-mode-start-plan"
					? "plan"
					: behavior === "stable-mode"
						? "default"
						: dependentConfigBehavior
							? "build"
							: "code",
			model: behavior === "cwd-model" ? params.cwd : "fake-fast",
			effort: "medium",
			mcpCount: params.mcpServers.length,
			additionalDirectories: params.additionalDirectories ?? [],
			mcpTransports: params.mcpServers.map((server) => server.type ?? "stdio"),
		};
		sessions.set(sessionId, session);
		return {
			sessionId,
			...sessionMetadata(session),
		};
	})
	.onRequest("session/load", async ({ params, client }) => {
		if (behavior === "hang-load") await stall("session load");
		if (behavior === "reject-load") {
			throw new Error("fake session is not durable");
		}
		if (behavior === "resume-preferred") {
			throw new Error("session/load must not be used when resume is available");
		}
		validateSessionInputs(params);
		const session = {
			cancelled: false,
			mode: "code",
			model: "fake-fast",
			effort: "medium",
			mcpCount: params.mcpServers.length,
			additionalDirectories: params.additionalDirectories ?? [],
			mcpTransports: params.mcpServers.map((server) => server.type ?? "stdio"),
		};
		sessions.set(params.sessionId, session);
		if (behavior === "load-only-replay") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "user_message_chunk",
					messageId: "historical-user",
					content: { type: "text", text: "historical question" },
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					messageId: "historical-agent",
					content: { type: "text", text: "historical answer" },
				},
			});
			await notifyThought(
				client,
				params.sessionId,
				"historical private analysis",
				"historical-thought",
			);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "historical-tool",
					title: "Historical tool",
					name: "history.tool",
					status: "completed",
					rawOutput: "historical output",
				},
			});
		}
		return sessionMetadata(session);
	})
	.onRequest("session/resume", async ({ params }) => {
		validateSessionInputs(params);
		const session = {
			cancelled: false,
			mode: "code",
			model: "fake-fast",
			effort: "medium",
			mcpCount: params.mcpServers?.length ?? 0,
			additionalDirectories: params.additionalDirectories ?? [],
			mcpTransports: (params.mcpServers ?? []).map(
				(server) => server.type ?? "stdio",
			),
		};
		sessions.set(params.sessionId, session);
		return sessionMetadata(session);
	})
	.onRequest("session/fork", async ({ params }) => {
		if (behavior === "hang-fork") await stall("session fork");
		const source = sessions.get(params.sessionId);
		const sessionId = `${params.sessionId}-fork`;
		const session = {
			...(source ?? {
				cancelled: false,
				mode: "code",
				model: "fake-fast",
				effort: "medium",
			}),
			cancelled: false,
			mcpCount: params.mcpServers?.length ?? 0,
		};
		sessions.set(sessionId, session);
		return {
			sessionId,
			...sessionMetadata(session),
		};
	})
	.onRequest("session/delete", ({ params }) => {
		sessions.delete(params.sessionId);
		if (process.env.HLID_FAKE_ACP_DELETE_MARKER) {
			appendFileSync(
				process.env.HLID_FAKE_ACP_DELETE_MARKER,
				`${params.sessionId}\n`,
			);
		}
		return {};
	})
	.onRequest("session/close", ({ params }) => {
		sessions.delete(params.sessionId);
		return {};
	})
	.onRequest("session/set_mode", async ({ params }) => {
		if (behavior === "hang-mode") await stall("legacy mode configuration");
		const session = sessions.get(params.sessionId);
		if (session) session.mode = params.modeId;
		return {};
	})
	.onRequest("session/set_config_option", async ({ params, client }) => {
		if (behavior === "hang-config") await stall("config option");
		const session = sessions.get(params.sessionId);
		if (session && params.configId === "model") {
			session.model =
				behavior === "misreport-model-selection"
					? "fake-smart"
					: behavior === "misreport-allowed-model-selection"
						? "fake-fast"
						: params.value;
			if (dependentConfigBehavior && params.value === "fake-smart") {
				session.effort = "high";
			}
		}
		if (session && params.configId === "thought") session.effort = params.value;
		if (session && params.configId === "mode") session.mode = params.value;
		if (dependentConfigBehavior) {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: configOptions(session),
				},
			});
		}
		if (
			behavior === "excluded-notification-during-config" &&
			session &&
			params.configId === "model"
		) {
			session.model = "fake-smart";
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: configOptions(session),
				},
			});
			session.model = params.value;
		}
		const responseOptions = configOptions(session);
		return {
			configOptions:
				behavior === "missing-model-selection" && params.configId === "model"
					? responseOptions.filter((option) => option.id !== "model")
					: responseOptions,
		};
	})
	.onNotification("session/cancel", ({ params }) => {
		const session = sessions.get(params.sessionId);
		if (session && !session.ignoreCancel) session.cancelled = true;
	})
	.onRequest("session/prompt", async ({ params, client }) => {
		if (process.env.HLID_FAKE_ACP_PROMPT_MARKER) {
			appendFileSync(process.env.HLID_FAKE_ACP_PROMPT_MARKER, "prompt\n");
		}
		const text =
			params.prompt.find((block) => block.type === "text")?.text ?? "";
		if (text === "thought-transport-error") {
			await notifyThought(
				client,
				params.sessionId,
				"partial transport thought",
			);
			process.exit(2);
		}
		if (text === "transport-error") process.exit(2);
		if (text === "slow") {
			while (!sessions.get(params.sessionId)?.cancelled) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return { stopReason: "cancelled" };
		}
		if (text === "ignore-cancel") {
			const session = sessions.get(params.sessionId);
			if (session) session.ignoreCancel = true;
			await never();
		}
		if (text === "thought-ignore-cancel") {
			await notifyThought(
				client,
				params.sessionId,
				"partial cancelled thought",
			);
			const session = sessions.get(params.sessionId);
			if (session) session.ignoreCancel = true;
			await never();
		}
		if (text === "exclude-model-notification") {
			const session = sessions.get(params.sessionId);
			if (session) session.model = "fake-fast";
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: configOptions(session),
				},
			});
			return { stopReason: "end_turn" };
		}
		if (
			text === "exclude-model-active" ||
			text === "thought-exclude-model-active" ||
			text === "missing-model-notification"
		) {
			if (text === "thought-exclude-model-active") {
				await notifyThought(
					client,
					params.sessionId,
					"partial retired thought",
				);
			}
			const session = sessions.get(params.sessionId);
			if (session) session.model = "fake-fast";
			const options = configOptions(session);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions:
						text === "missing-model-notification"
							? options.filter((option) => option.id !== "model")
							: options,
				},
			});
			for (let index = 0; index < 5; index += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "post-fault-output" },
					},
				});
			}
			return { stopReason: "end_turn" };
		}
		if (text === "report-mode") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: sessions.get(params.sessionId)?.mode ?? "unknown",
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "report-config") {
			const session = sessions.get(params.sessionId);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `${session?.model}/${session?.effort}`,
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "report-mcp") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: String(sessions.get(params.sessionId)?.mcpCount ?? 0),
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		const internalMcpToolName =
			text === "use-hlid-mcp"
				? "hlid_hlid_help"
				: text === "use-obsidian-mcp"
					? "hlid_obsidian_vault_info"
					: text === "use-similar-mcp-name"
						? "hlid_obsidian_not_a_real_tool"
						: null;
		if (internalMcpToolName) {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: `internal-mcp-${text}`,
					title: "Internal MCP tool",
					name: internalMcpToolName,
					kind: "other",
					status: "completed",
					rawInput: {},
					rawOutput: "ok",
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "use-obsidian-mcp-late-name") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "internal-mcp-late-name",
					title: "Internal MCP tool",
					name: null,
					kind: "other",
					status: "pending",
					rawInput: {},
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "internal-mcp-late-name",
					name: "hlid_obsidian_vault_info",
					status: "completed",
					rawOutput: "ok",
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "report-session-inputs") {
			const session = sessions.get(params.sessionId);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: JSON.stringify({
							additionalDirectories: session?.additionalDirectories ?? [],
							mcpTransports: session?.mcpTransports ?? [],
						}),
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "message-boundaries") {
			for (const [messageId, chunk] of [
				["message-a", "first "],
				["message-a", "message"],
				["message-b", "second message"],
			]) {
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						messageId,
						content: { type: "text", text: chunk },
					},
				});
			}
			return { stopReason: "end_turn" };
		}
		if (text === "thought-chunk") {
			for (const chunk of ["private provider ", "analysis"]) {
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						messageId: "thought-a",
						content: { type: "text", text: chunk },
					},
				});
			}
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "visible answer" },
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "elicit") {
			const response = await client.request(methods.client.elicitation.create, {
				mode: "form",
				sessionId: params.sessionId,
				message: "Choose deployment settings",
				requestedSchema: {
					type: "object",
					properties: {
						environment: {
							type: "string",
							title: "Environment",
							enum: ["staging", "production"],
						},
						replicas: {
							type: "integer",
							title: "Replicas",
						},
					},
					required: ["environment", "replicas"],
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: JSON.stringify(response) },
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "plan-update" || text === "plan-refusal") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "plan",
					entries: [
						{ content: "Research", priority: "high", status: "in_progress" },
					],
				},
			});
			return {
				stopReason: text === "plan-refusal" ? "refusal" : "end_turn",
			};
		}
		if (text === "plan-remove") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "plan_update",
					plan: {
						type: "markdown",
						planId: "draft",
						content: "# Draft",
					},
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: { sessionUpdate: "plan_removed", planId: "draft" },
			});
			return { stopReason: "end_turn" };
		}
		if (text === "usage-update") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 1234,
					size: 8192,
					cost: { amount: 0.25, currency: "USD" },
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "structured-tool") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "structured-1",
					title: "Edit a file",
					kind: "edit",
					status: "completed",
					rawInput: { path: "a.txt" },
					content: [
						{
							type: "diff",
							path: "a.txt",
							oldText: "old",
							newText: "new",
						},
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "patch-tool") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "patch-1",
					title: "Patch tool",
					name: "custom.patch",
					kind: "other",
					status: "pending",
					rawInput: { value: 1 },
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "patch-1",
					status: "in_progress",
					content: [
						{
							type: "content",
							content: { type: "text", text: "result from earlier patch" },
						},
					],
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "patch-1",
					status: "completed",
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "tool-progress" || text === "tool-progress-long") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "progress-1",
					title: "Run progress tool",
					name: "custom.progress",
					kind: "execute",
					status: "pending",
					rawInput: { command: "long-task" },
				},
			});
			const progressOutputs =
				text === "tool-progress-long"
					? ["x".repeat(20_000)]
					: ["Starting", "Starting", "Halfway"];
			for (const rawOutput of progressOutputs) {
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "progress-1",
						status: "in_progress",
						rawOutput,
					},
				});
			}
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "progress-1",
					status: "completed",
					rawOutput: "Done",
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "progress-1",
					status: "in_progress",
					rawOutput: "Late progress",
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "progress-1",
					status: "completed",
					rawOutput: "Duplicate completion",
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "permission-options") {
			const tool = {
				toolCallId: "permission-options-1",
				title: "Review proposed edit",
				name: "filesystem.edit",
				kind: "edit",
				rawInput: { path: "alias.md" },
				locations: [{ path: "/vault/note.md", line: 7 }],
				content: [
					{
						type: "diff",
						path: "/vault/note.md",
						oldText: "before",
						newText: "after",
					},
					{
						type: "content",
						content: { type: "text", text: "Edit the selected note" },
					},
				],
			};
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: { sessionUpdate: "tool_call", ...tool, status: "pending" },
			});
			const permission = await client.request(
				methods.client.session.requestPermission,
				{
					sessionId: params.sessionId,
					toolCall: tool,
					options: [
						{
							optionId: "allow-always",
							name: "Always allow",
							kind: "allow_always",
						},
						{
							optionId: "reject-always",
							name: "Always reject",
							kind: "reject_always",
						},
						{
							optionId: "allow-once",
							name: "Allow once",
							kind: "allow_once",
						},
						{
							optionId: "reject-once",
							name: "Reject once",
							kind: "reject_once",
						},
					],
				},
			);
			const selected =
				permission.outcome.outcome === "selected"
					? permission.outcome.optionId
					: "cancelled";
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "permission-options-1",
					status: "completed",
					rawOutput: selected,
					content: [
						{
							type: "content",
							content: { type: "text", text: selected },
						},
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "locations-tool") {
			const tool = {
				toolCallId: "locations-1",
				title: "Edit selected file",
				name: "filesystem.edit",
				kind: "edit",
				rawInput: { path: "selection-alias" },
				locations: [{ path: "/vault/selected.md", line: 12 }],
			};
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: { sessionUpdate: "tool_call", ...tool, status: "pending" },
			});
			await client.request(methods.client.session.requestPermission, {
				sessionId: params.sessionId,
				toolCall: tool,
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "locations-1",
					status: "completed",
					rawOutput: "edited",
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "obsidian-long-result") {
			const path = "Projects/Hlid.md";
			const content = "x".repeat(2_000);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "obsidian-long-1",
					title: "hlid_obsidian.append_note",
					kind: "other",
					status: "pending",
					rawInput: { target: "path", path, content },
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "obsidian-long-1",
					status: "completed",
					rawOutput: {
						arguments: { target: "path", path, content },
						result: { path },
					},
					content: [
						{
							type: "content",
							content: {
								type: "text",
								text: JSON.stringify({ path }),
							},
						},
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "tool-kind-matrix") {
			const tools = [
				["read", "Read file"],
				["edit", "Edit file"],
				["delete", "Delete file"],
				["move", "Move file"],
				["search", "Search files"],
				["execute", "Run command"],
				["think", "Think"],
				["fetch", "Fetch URL"],
				["switch_mode", "Planning mode"],
				["other", "Custom action"],
			];
			for (const [index, [kind, title]] of tools.entries()) {
				const toolCall = {
					toolCallId: `kind-${index}`,
					title,
					...((kind === "switch_mode" || kind === "other") && {
						name: kind === "switch_mode" ? "session.set_mode" : "custom.action",
					}),
					kind,
					rawInput: { kind },
				};
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call",
						...toolCall,
						status: "pending",
					},
				});
				await client.request(methods.client.session.requestPermission, {
					sessionId: params.sessionId,
					toolCall,
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "deny", name: "Deny", kind: "reject_once" },
					],
				});
			}
			return { stopReason: "end_turn" };
		}
		if (text.startsWith("The user approved the plan.")) {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "implemented" },
				},
			});
			return { stopReason: "end_turn" };
		}
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "help", description: "Show help", input: { hint: "topic" } },
				],
			},
		});
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello " },
			},
		});
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "world" },
			},
		});
		if (text === "html-plan-missing") {
			return { stopReason: "end_turn" };
		}
		const obsidianCommand = text === "obsidian-command";
		const tool = {
			toolCallId: "tool-1",
			title: obsidianCommand
				? "Obsidian run command"
				: text === "read-permission"
					? "Read file"
					: "Write file",
			kind: obsidianCommand
				? "execute"
				: text === "read-permission"
					? "read"
					: "edit",
			...(obsidianCommand
				? { name: "hlid_obsidian.run_command" }
				: text === "html-plan" || text === "html-plan-failed"
					? { name: "filesystem.write" }
					: {}),
			rawInput: obsidianCommand
				? { id: "app:toggle-left-sidebar" }
				: {
						path:
							text === "html-plan" || text === "html-plan-failed"
								? "/vault/.hlid/plans/plan-fake.html"
								: "a.txt",
					},
		};
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "tool_call", ...tool, status: "pending" },
		});
		const permission = await client.request(
			methods.client.session.requestPermission,
			{
				sessionId: params.sessionId,
				toolCall: tool,
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			},
		);
		const allowed =
			permission.outcome.outcome === "selected" &&
			permission.outcome.optionId === "allow";
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: allowed && text !== "html-plan-failed" ? "completed" : "failed",
				rawOutput:
					allowed && text !== "html-plan-failed"
						? "allowed"
						: "permission_denied",
			},
		});
		return {
			stopReason: text === "max" ? "max_turn_requests" : "end_turn",
			usage: {
				totalTokens: 7,
				inputTokens: 4,
				outputTokens: 3,
				cachedReadTokens: 1,
			},
		};
	})
	.connect(stream);
