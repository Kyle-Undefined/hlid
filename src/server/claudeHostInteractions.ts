import type {
	ElicitationRequest,
	OnElicitation,
	OnUserDialog,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentQueryParams, AgentToolDecision } from "./agentProvider";
import {
	firstProviderInteractionString,
	isProviderInteractionRecord,
	parseProviderElicitationFields,
	providerElicitationContent,
	providerElicitationDecisionAnswers,
	providerElicitationQuestions,
	providerElicitationSelectedAnswer,
	providerElicitationWasCancelled,
	safeProviderElicitationUrl,
} from "./providerElicitation";

export const CLAUDE_SUPPORTED_DIALOG_KINDS = [
	"refusal_fallback_prompt",
	"peer_inbound_approval",
] as const;

const URL_CONTINUE = "Continue after completing the browser step";
const URL_DECLINE = "Decline this request";
const DIALOG_RETRY = "Retry with the fallback model";
const DIALOG_EDIT = "Edit the prompt and retry";
const PEER_DELIVER = "Deliver to Claude";
const PEER_DENY = "Deny";
const PEER_QUESTION = "Deliver this held peer message to Claude?";
const PEER_HOLD_CAUSES = new Set([
	"mode-mismatch",
	"no-mode-asserted",
	"explicit-setting",
	"bypass-default",
	"mode-unknown",
]);

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

function peerDialogPayload(payload: Record<string, unknown>): {
	preview: string;
	from_address?: string;
	claimed_name?: string;
	verified_peer_pid?: number;
	hold_cause?:
		| "mode-mismatch"
		| "no-mode-asserted"
		| "explicit-setting"
		| "bypass-default"
		| "mode-unknown";
} | null {
	const preview = firstProviderInteractionString(payload, ["preview"]);
	if (!preview) return null;
	const fromAddress = firstProviderInteractionString(payload, [
		"fromAddress",
	])?.slice(0, 1_024);
	const claimedName = firstProviderInteractionString(payload, [
		"claimedName",
	])?.slice(0, 512);
	const verifiedPeerPid = payload.verifiedPeerPid;
	const holdCause = payload.holdCause;
	return {
		preview: preview.slice(0, 4_096),
		...(fromAddress ? { from_address: fromAddress } : {}),
		...(claimedName ? { claimed_name: claimedName } : {}),
		...(typeof verifiedPeerPid === "number" &&
		Number.isSafeInteger(verifiedPeerPid) &&
		verifiedPeerPid > 0
			? { verified_peer_pid: verifiedPeerPid }
			: {}),
		...(typeof holdCause === "string" && PEER_HOLD_CAUSES.has(holdCause)
			? {
					hold_cause: holdCause as
						| "mode-mismatch"
						| "no-mode-asserted"
						| "explicit-setting"
						| "bypass-default"
						| "mode-unknown",
				}
			: {}),
	};
}

export function createClaudeHostInteractionHandlers(params: AgentQueryParams): {
	onElicitation: OnElicitation;
	onUserDialog: OnUserDialog;
	supportedDialogKinds: string[];
} {
	const ask = async (
		...args: Parameters<AgentQueryParams["canUseTool"]>
	): Promise<AgentToolDecision | null> =>
		params.canUseTool(...args).catch(() => null);
	const interactionId = (kind: string, controlRequestId: string) =>
		`claude-${kind}:${params.hostSessionId ?? "ephemeral"}:${controlRequestId}`;

	const onElicitation: OnElicitation = async (request, options) => {
		if (options.signal.aborted) return { action: "cancel" };
		const mode = request.mode ?? (request.url ? "url" : "form");
		if (mode === "url") {
			// The SDK callback contract includes URL mode, although the pinned
			// headless Claude MCP client does not currently advertise it to servers.
			// Keep this mapping ready for a provider runtime that exposes the mode.
			const url = safeProviderElicitationUrl(request.url);
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
					toolUseID: interactionId("elicitation", options.requestId),
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
			const answers = providerElicitationDecisionAnswers(decision);
			if (options.signal.aborted || providerElicitationWasCancelled(answers)) {
				return { action: "cancel" };
			}
			const rawAnswer =
				answers?.["How should Hlid answer this browser-based request?"];
			const answer = providerElicitationSelectedAnswer(rawAnswer);
			if (answer === URL_CONTINUE) return { action: "accept" };
			return { action: "decline" };
		}

		const fields = parseProviderElicitationFields(request.requestedSchema);
		if (!fields) return { action: "decline" };
		const decision = await ask(
			"AskUserQuestion",
			{ questions: providerElicitationQuestions(fields) },
			{
				toolUseID: interactionId("elicitation", options.requestId),
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
		const answers = providerElicitationDecisionAnswers(decision);
		if (options.signal.aborted || providerElicitationWasCancelled(answers)) {
			return { action: "cancel" };
		}
		if (!answers) return { action: "decline" };
		const content = providerElicitationContent(fields, answers);
		return content ? { action: "accept", content } : { action: "cancel" };
	};

	const onUserDialog: OnUserDialog = async (request, options) => {
		if (options.signal.aborted) {
			return { behavior: "cancelled" };
		}
		const payload = isProviderInteractionRecord(request.payload)
			? request.payload
			: {};
		if (request.dialogKind === "peer_inbound_approval") {
			const peer = peerDialogPayload(payload);
			if (!peer || !params.onProviderInitiatedTurn) {
				return { behavior: "cancelled" };
			}
			const sourceName = peer.from_address ?? "another Claude session";
			const dialogInteractionId = interactionId("dialog", options.requestId);
			const decision = await ask(
				"AskUserQuestion",
				{
					questions: [
						{
							question: PEER_QUESTION,
							options: [PEER_DELIVER, PEER_DENY],
							multiSelect: false,
						},
					],
				},
				{
					toolUseID: dialogInteractionId,
					signal: options.signal,
					title: "Claude peer message",
					displayName: request.dialogKind,
					description:
						"Held outside Claude until you decide. Sender details are provider provenance, not human authority.",
					interaction: {
						provider_id: "claude",
						kind: "provider_dialog",
						source_name: sourceName,
						summary: "Inbound peer message held for review",
						peer,
						...(request.toolUseID ? { tool_use_id: request.toolUseID } : {}),
					},
				},
			);
			const answers = providerElicitationDecisionAnswers(decision);
			if (options.signal.aborted || providerElicitationWasCancelled(answers)) {
				return { behavior: "cancelled" };
			}
			const rawAnswer = answers?.[PEER_QUESTION];
			const answer = providerElicitationSelectedAnswer(rawAnswer);
			if (answer === PEER_DENY) {
				return { behavior: "completed", result: { behavior: "deny" } };
			}
			if (answer !== PEER_DELIVER) return { behavior: "cancelled" };
			const consumerReady = await params
				.onProviderInitiatedTurn({
					kind: "claude_peer_message",
					interactionId: dialogInteractionId,
					sourceName,
					...(request.toolUseID ? { toolUseId: request.toolUseID } : {}),
					preview: peer.preview,
					signal: options.signal,
					...(peer.from_address ? { fromAddress: peer.from_address } : {}),
					...(peer.claimed_name ? { claimedName: peer.claimed_name } : {}),
					...(peer.verified_peer_pid !== undefined
						? { verifiedPeerPid: peer.verified_peer_pid }
						: {}),
					...(peer.hold_cause ? { holdCause: peer.hold_cause } : {}),
				})
				.catch(() => false);
			if (options.signal.aborted || !consumerReady) {
				return { behavior: "cancelled" };
			}
			return { behavior: "completed", result: { behavior: "approve" } };
		}
		if (request.dialogKind !== "refusal_fallback_prompt") {
			return { behavior: "cancelled" };
		}
		const question =
			firstProviderInteractionString(payload, [
				"message",
				"title",
				"description",
			]) ?? "Claude paused after a safety refusal. How should Hlid continue?";
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
				toolUseID: interactionId("dialog", options.requestId),
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
		const answers = providerElicitationDecisionAnswers(decision);
		if (options.signal.aborted || providerElicitationWasCancelled(answers)) {
			return { behavior: "cancelled" };
		}
		const rawAnswer = answers?.[question];
		const answer = providerElicitationSelectedAnswer(rawAnswer);
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
