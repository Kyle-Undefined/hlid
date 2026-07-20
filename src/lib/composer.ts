import type { QueuedChatMessage } from "#/hooks/wsChatQueueStore";
import type { ChatAttachment, ClientChatMessage } from "#/server/protocol";
import type { CommandAction } from "./commands";
import { formatVaultReferencedMessage } from "./vaultReferences";

export type ComposerKeyAction =
	| "picker-next"
	| "picker-previous"
	| "picker-close"
	| "picker-select"
	| "submit"
	| null;

export function composerKeyAction(input: {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	pickerOpen: boolean;
	isTouch: boolean;
	enterToSubmit: boolean;
}): ComposerKeyAction {
	if (input.pickerOpen) {
		if (input.key === "ArrowDown") return "picker-next";
		if (input.key === "ArrowUp") return "picker-previous";
		if (input.key === "Escape") return "picker-close";
		if (input.key === "Tab") return "picker-select";
		if (
			input.key === "Enter" &&
			!input.shiftKey &&
			!input.metaKey &&
			!input.ctrlKey
		) {
			return "picker-select";
		}
	}
	if (input.key !== "Enter" || input.shiftKey) return null;
	if (input.metaKey || input.ctrlKey) return "submit";
	if (!input.isTouch && input.enterToSubmit) return "submit";
	return null;
}

export function runComposerPickerAction(
	action: ComposerKeyAction,
	picker: {
		items: readonly unknown[];
		navigate: (direction: 1 | -1) => void;
		close: () => void;
	},
	select: () => void,
): boolean {
	if (action === "picker-next") picker.navigate(1);
	if (action === "picker-previous") picker.navigate(-1);
	if (action === "picker-close") picker.close();
	if (action === "picker-select" && picker.items.length > 0) select();
	return action === "submit";
}

export function insertAtSelection(
	value: string,
	text: string,
	start = value.length,
	end = start,
): string {
	const safeStart = Math.max(0, Math.min(start, value.length));
	const safeEnd = Math.max(safeStart, Math.min(end, value.length));
	const before = value.slice(0, safeStart);
	const after = value.slice(safeEnd);
	const separator = before && !/\s$/.test(before) ? " " : "";
	return `${before}${separator}${text}${after}`;
}

export function resizeComposer(
	element: {
		scrollHeight: number;
		scrollTop: number;
		selectionEnd: number;
		value: string;
		style: { height: string; overflowY: string };
	} | null,
	maxHeight: number,
): void {
	if (!element) return;
	element.style.height = "auto";
	const contentHeight = element.scrollHeight;
	const capped = contentHeight > maxHeight;
	element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
	element.style.overflowY = capped ? "auto" : "hidden";
	// Do not restore an older scroll offset after resizing: that can leave the
	// active caret below the visible editor. When composing at the end, follow
	// the new bottom explicitly; native textarea behavior handles middle edits.
	if (capped && element.selectionEnd === element.value.length) {
		element.scrollTop = contentHeight;
	}
}

/**
 * Keep an expanding composer inside the currently visible viewport. Mobile
 * landscape and installed-PWA keyboard transitions can leave far less height
 * than their width suggests, so a width-only 240px cap can push the input row
 * below an overflow-hidden chat shell.
 */
export function responsiveComposerMaxHeight(
	viewportWidth: number,
	viewportHeight: number,
): number {
	const mobile = viewportWidth < 768;
	const fixedMax = mobile ? 320 : 480;
	const viewportShare = 0.5;
	return Math.max(
		60,
		Math.min(fixedMax, Math.floor(viewportHeight * viewportShare)),
	);
}

export type ChatSubmission =
	| { kind: "queued"; message: QueuedChatMessage }
	| {
			kind: "immediate";
			user: { id: string; text: string; attachments: ChatAttachment[] };
			message: ClientChatMessage;
			marksAgentContextSent: boolean;
	  };

function sessionControlFields(input: {
	planMode: boolean;
	planHtml: boolean;
	provider?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
}) {
	return {
		plan_mode: input.planMode || undefined,
		plan_html: (input.planMode && input.planHtml) || undefined,
		...(input.provider ? { provider: input.provider } : {}),
		...(input.model ? { model: input.model } : {}),
		...(input.effort ? { effort: input.effort } : {}),
		...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
	};
}

export function prepareChatSubmission(input: {
	id: string;
	text: string;
	sessionId: string;
	running: boolean;
	skillContexts?: string[];
	commandAction?: CommandAction;
	attachments: ChatAttachment[];
	vaultReferences?: string[];
	agentCwd?: string;
	agentContextAlreadySent: boolean;
	planMode: boolean;
	planHtml: boolean;
	provider?: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
}): ChatSubmission | null {
	if (
		!input.text &&
		input.attachments.length === 0 &&
		(input.vaultReferences?.length ?? 0) === 0
	)
		return null;
	const attachments =
		input.attachments.length > 0 ? [...input.attachments] : undefined;
	const sessionControls = sessionControlFields(input);
	if (input.running) {
		return {
			kind: "queued",
			message: {
				id: input.id,
				text: input.text,
				session_id: input.sessionId,
				skill_contexts: input.skillContexts,
				command_action: input.commandAction,
				attachments,
				vault_references: input.vaultReferences,
				agent_cwd: input.agentCwd,
				...sessionControls,
			},
		};
	}

	const agentCwd =
		input.agentCwd && !input.agentContextAlreadySent
			? input.agentCwd
			: undefined;
	return {
		kind: "immediate",
		user: {
			id: input.id,
			text: formatVaultReferencedMessage(
				input.text,
				input.vaultReferences ?? [],
			),
			attachments: input.attachments,
		},
		message: {
			type: "chat",
			text: input.text,
			session_id: input.sessionId,
			skill_contexts: input.skillContexts,
			command_action: input.commandAction,
			attachments,
			vault_references: input.vaultReferences,
			agent_cwd: agentCwd,
			...sessionControls,
		},
		marksAgentContextSent: agentCwd !== undefined,
	};
}
