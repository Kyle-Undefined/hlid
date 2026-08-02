import type {
	ElicitationRequest,
	OnElicitation,
	OnUserDialog,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryParams, AgentToolDecision } from "./agentProvider";
import { ASK_USER_QUESTION_CANCEL_KEY } from "./protocol";
import { providerElicitationQuestions } from "./providerElicitation";

export const CLAUDE_SUPPORTED_DIALOG_KINDS = [
	"refusal_fallback_prompt",
] as const;

const URL_CONTINUE = "Continue after completing the browser step";
const URL_DECLINE = "Decline this request";
const DIALOG_RETRY = "Retry with the fallback model";
const DIALOG_EDIT = "Edit the prompt and retry";

type Primitive = string | number | boolean;
type ElicitationField = {
	key: string;
	question: string;
	type: "string" | "number" | "integer" | "boolean" | "array";
	values: Map<string, Primitive>;
	freeText: boolean;
	optional: boolean;
	placeholder?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function safeExternalUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function uniqueQuestion(base: string, key: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let candidate = `${base} (${key})`;
	let suffix = 2;
	while (used.has(candidate)) candidate = `${base} (${key} ${suffix++})`;
	used.add(candidate);
	return candidate;
}

function enumValues(
	property: Record<string, unknown>,
	type: ElicitationField["type"],
): Map<string, Primitive> | null {
	const matchesType = (value: unknown): value is Primitive => {
		if (type === "string") return typeof value === "string";
		if (type === "boolean") return typeof value === "boolean";
		return typeof value === "number";
	};
	const values = new Map<string, Primitive>();
	const rawEnum = property.enum;
	if (Array.isArray(rawEnum)) {
		for (const value of rawEnum) {
			if (!matchesType(value)) return null;
			values.set(String(value), value);
		}
	}
	const alternatives = Array.isArray(property.oneOf)
		? property.oneOf
		: Array.isArray(property.anyOf)
			? property.anyOf
			: [];
	for (const alternative of alternatives) {
		if (!isRecord(alternative)) return null;
		const value = alternative.const;
		if (!matchesType(value)) return null;
		const label = firstString(alternative, ["title"]) ?? String(value);
		values.set(label, value);
	}
	return values;
}

function elicitationFields(
	request: ElicitationRequest,
): ElicitationField[] | null {
	if (request.mode === "url" || !isRecord(request.requestedSchema)) {
		return null;
	}
	const schema = request.requestedSchema;
	if (schema.type !== undefined && schema.type !== "object") return null;
	if (!isRecord(schema.properties)) return null;
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
	);
	const usedQuestions = new Set<string>();
	const fields: ElicitationField[] = [];
	for (const [key, rawProperty] of Object.entries(schema.properties)) {
		if (!isRecord(rawProperty) || typeof rawProperty.type !== "string") {
			return null;
		}
		const baseQuestion = firstString(rawProperty, ["title"]) ?? key;
		const question = uniqueQuestion(baseQuestion, key, usedQuestions);
		const placeholder = firstString(rawProperty, ["description"]);
		const optional = !required.has(key);
		switch (rawProperty.type) {
			case "string":
			case "number":
			case "integer": {
				const values = enumValues(rawProperty, rawProperty.type);
				if (!values) return null;
				fields.push({
					key,
					question,
					type: rawProperty.type,
					values,
					freeText: values.size === 0,
					optional,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			}
			case "boolean":
				fields.push({
					key,
					question,
					type: "boolean",
					values: new Map([
						["Yes", true],
						["No", false],
					]),
					freeText: false,
					optional,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			case "array": {
				if (!isRecord(rawProperty.items)) return null;
				const itemType = rawProperty.items.type;
				if (itemType !== undefined && itemType !== "string") return null;
				const values = enumValues(rawProperty.items, "string");
				if (!values || values.size === 0) return null;
				fields.push({
					key,
					question,
					type: "array",
					values,
					freeText: false,
					optional,
					...(placeholder ? { placeholder } : {}),
				});
				break;
			}
			default:
				return null;
		}
	}
	return fields.length > 0 ? fields : null;
}

function splitAnswer(raw: string): { selections: string[]; note: string } {
	const [selectionText = "", note = ""] = raw.split("\n\nNotes:", 2);
	return {
		selections: selectionText ? selectionText.split(", ") : [],
		note: note.trim(),
	};
}

function elicitationContent(
	fields: ElicitationField[],
	answers: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> | null {
	const content: Record<string, string | number | boolean | string[]> = {};
	for (const field of fields) {
		const answer = answers[field.question];
		const raw = typeof answer === "string" ? answer : "";
		const { selections, note } = splitAnswer(raw);
		if (!raw.trim() && !note) {
			if (field.optional) continue;
			return null;
		}
		if (field.type === "array") {
			const mapped = selections.flatMap((selection) => {
				const value = field.values.get(selection);
				return typeof value === "string" ? [value] : [];
			});
			if (mapped.length === 0 && !field.optional) return null;
			if (mapped.length > 0) content[field.key] = mapped;
			continue;
		}
		const selectedLabel = selections.join(", ");
		const selected = field.values.get(selectedLabel);
		const value = selected ?? selections[0] ?? note;
		if (field.type === "boolean") {
			if (typeof selected !== "boolean") return null;
			content[field.key] = selected;
		} else if (field.type === "number" || field.type === "integer") {
			const number = typeof selected === "number" ? selected : Number(value);
			if (!Number.isFinite(number)) return null;
			if (field.type === "integer" && !Number.isInteger(number)) return null;
			content[field.key] = number;
		} else if (typeof value === "string" && value) {
			content[field.key] = value;
		} else {
			return null;
		}
	}
	return content;
}

function decisionAnswers(
	decision: AgentToolDecision | null,
): Record<string, unknown> | null {
	if (
		decision === null ||
		decision.behavior !== "allow" ||
		!isRecord(decision.updatedInput)
	) {
		return null;
	}
	return isRecord(decision.updatedInput.answers)
		? decision.updatedInput.answers
		: null;
}

function cancelled(answers: Record<string, unknown> | null): boolean {
	return answers !== null && ASK_USER_QUESTION_CANCEL_KEY in answers;
}

function elicitationSummary(request: ElicitationRequest): string {
	return [request.title, request.description, request.message]
		.filter(
			(value, index, all): value is string =>
				typeof value === "string" &&
				Boolean(value.trim()) &&
				all.indexOf(value) === index,
		)
		.join("\n");
}

export function createClaudeHostInteractionHandlers(params: AgentQueryParams): {
	onElicitation: OnElicitation;
	onUserDialog: OnUserDialog;
	supportedDialogKinds: string[];
} {
	let sequence = 0;
	const ask = async (
		...args: Parameters<AgentQueryParams["canUseTool"]>
	): Promise<AgentToolDecision | null> =>
		params.canUseTool(...args).catch(() => null);
	const requestId = (kind: string, nativeId?: string) =>
		`claude-${kind}:${params.hostSessionId ?? "ephemeral"}:${nativeId ?? ++sequence}`;

	const onElicitation: OnElicitation = async (request, options) => {
		if (options.signal.aborted) return { action: "cancel" };
		const mode = request.mode ?? (request.url ? "url" : "form");
		if (mode === "url") {
			// The SDK callback contract includes URL mode, although the pinned
			// headless Claude MCP client does not currently advertise it to servers.
			// Keep this mapping ready for a provider runtime that exposes the mode.
			const url = safeExternalUrl(request.url);
			if (!url) return { action: "decline" };
			const decision = await ask(
				"AskUserQuestion",
				{
					questions: [
						{
							question: "How should Hlid answer this browser-based request?",
							options: [URL_CONTINUE, URL_DECLINE],
							multiSelect: false,
						},
					],
				},
				{
					toolUseID: requestId("elicitation", request.elicitationId),
					signal: options.signal,
					title: request.title ?? request.message,
					displayName: request.displayName ?? request.serverName,
					description: request.description,
					interaction: {
						provider_id: "claude",
						kind: "mcp_elicitation",
						source_name: request.serverName,
						...(request.displayName ? { tool_name: request.displayName } : {}),
						summary: elicitationSummary(request),
						url,
					},
				},
			);
			const answers = decisionAnswers(decision);
			if (options.signal.aborted || cancelled(answers)) {
				return { action: "cancel" };
			}
			const rawAnswer =
				answers?.["How should Hlid answer this browser-based request?"];
			const answer =
				typeof rawAnswer === "string"
					? splitAnswer(rawAnswer).selections.join(", ")
					: undefined;
			if (answer === URL_CONTINUE) return { action: "accept" };
			return { action: "decline" };
		}

		const fields = elicitationFields(request);
		if (!fields) return { action: "decline" };
		const decision = await ask(
			"AskUserQuestion",
			{ questions: providerElicitationQuestions(fields) },
			{
				toolUseID: requestId("elicitation", request.elicitationId),
				signal: options.signal,
				title: request.title ?? request.message,
				displayName: request.displayName ?? request.serverName,
				description: request.description,
				interaction: {
					provider_id: "claude",
					kind: "mcp_elicitation",
					source_name: request.serverName,
					...(request.displayName ? { tool_name: request.displayName } : {}),
					summary: elicitationSummary(request),
				},
			},
		);
		const answers = decisionAnswers(decision);
		if (options.signal.aborted || cancelled(answers)) {
			return { action: "cancel" };
		}
		if (!answers) return { action: "decline" };
		const content = elicitationContent(fields, answers);
		return content ? { action: "accept", content } : { action: "cancel" };
	};

	const onUserDialog: OnUserDialog = async (request, options) => {
		if (
			options.signal.aborted ||
			request.dialogKind !== "refusal_fallback_prompt"
		) {
			return { behavior: "cancelled" };
		}
		const payload = isRecord(request.payload) ? request.payload : {};
		const question =
			firstString(payload, ["message", "title", "description"]) ??
			"Claude paused after a safety refusal. How should Hlid continue?";
		const decision = await ask(
			"AskUserQuestion",
			{
				questions: [
					{
						question,
						options: [DIALOG_RETRY, DIALOG_EDIT],
						multiSelect: false,
					},
				],
			},
			{
				toolUseID: requestId("dialog", request.toolUseID),
				signal: options.signal,
				title: "Claude needs input",
				displayName: request.dialogKind,
				interaction: {
					provider_id: "claude",
					kind: "provider_dialog",
					source_name: request.dialogKind,
					summary: question,
					...(request.toolUseID ? { tool_use_id: request.toolUseID } : {}),
				},
			},
		);
		const answers = decisionAnswers(decision);
		if (options.signal.aborted || cancelled(answers)) {
			return { behavior: "cancelled" };
		}
		const rawAnswer = answers?.[question];
		const answer =
			typeof rawAnswer === "string"
				? splitAnswer(rawAnswer).selections.join(", ")
				: undefined;
		if (answer === DIALOG_RETRY) {
			return { behavior: "completed", result: "retry_fallback" };
		}
		if (answer === DIALOG_EDIT) {
			return { behavior: "completed", result: "edit_prompt" };
		}
		return { behavior: "cancelled" };
	};

	return {
		onElicitation,
		onUserDialog,
		supportedDialogKinds: [...CLAUDE_SUPPORTED_DIALOG_KINDS],
	};
}
