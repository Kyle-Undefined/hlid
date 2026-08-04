import { isObsidianMutationToolName } from "#/lib/toolEventPaging";
import type { ToolEventMessage } from "#/server/protocol";

export type VaultChangeKind =
	| "created"
	| "appended"
	| "prepended"
	| "replaced"
	| "patched"
	| "moved"
	| "renamed"
	| "trashed"
	| "base"
	| "task"
	| "property-set"
	| "property-remove"
	| "command";

export type ObsidianVaultChange = {
	id: string;
	kind: VaultChangeKind;
	path?: string;
	from?: string;
	content?: string;
	previousContent?: string;
	commandId?: string;
	activeBefore?: string;
	activeAfter?: string;
	summary?: string;
};

const OPERATION_NAMES = {
	create_note: "created",
	capture_note: "created",
	append_note: "appended",
	prepend_note: "prepended",
	replace_note_text: "replaced",
	patch_note: "patched",
	move_file: "moved",
	rename_file: "renamed",
	trash_file: "trashed",
	base_create: "base",
	task_update: "task",
	property_set: "property-set",
	property_remove: "property-remove",
	run_command: "command",
} as const satisfies Record<string, VaultChangeKind>;

type VaultOperation = keyof typeof OPERATION_NAMES;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function operationFromToolName(name: string): VaultOperation | null {
	if (!isObsidianMutationToolName(name)) return null;
	const normalized = name.toLowerCase();
	for (const operation of Object.keys(OPERATION_NAMES) as VaultOperation[]) {
		if (
			normalized === operation ||
			normalized.endsWith(`__${operation}`) ||
			normalized.endsWith(`.${operation}`) ||
			normalized.endsWith(`/${operation}`) ||
			normalized.endsWith(`:${operation}`)
		) {
			return operation;
		}
	}
	return null;
}

function resultRecord(
	result: string | undefined,
): Record<string, unknown> | null {
	if (!result) return null;
	try {
		const parsed: unknown = JSON.parse(result);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const direct = parsed as Record<string, unknown>;
		for (const key of ["contentItems", "content"]) {
			const items = direct[key];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				const nested = record(item);
				if (typeof nested.text !== "string") continue;
				const unwrapped = resultRecord(nested.text);
				if (unwrapped) return unwrapped;
			}
		}
		return direct;
	} catch {
		return null;
	}
}

function resultIndicatesFailure(result: string): boolean {
	try {
		const parsed = record(JSON.parse(result));
		if (parsed.success === false) return true;
		const status =
			typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
		return [
			"failed",
			"error",
			"errored",
			"cancelled",
			"canceled",
			"declined",
		].includes(status);
	} catch {
		return false;
	}
}

function resultPath(result: Record<string, unknown> | null): string | null {
	const path = result?.path;
	return typeof path === "string" && path ? path : null;
}

function renamedPath(source: string, name: string): string {
	const slash = source.lastIndexOf("/");
	return slash < 0 ? name : `${source.slice(0, slash)}/${name}`;
}

function inlineValue(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "unknown";
	return serialized.length > 240 ? `${serialized.slice(0, 240)}…` : serialized;
}

function patchContent(
	replacements: unknown[],
	key: "oldText" | "newText",
): string {
	return replacements
		.map((item, index) => {
			const value = record(item)[key];
			return typeof value === "string"
				? `[${index + 1}]\n${value}`
				: `[${index + 1}]`;
		})
		.join("\n\n");
}

type VaultChangeParser = (
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
) => ObsidianVaultChange | null;

function inputPath(input: Record<string, unknown>): string | null {
	return typeof input.path === "string" && input.path ? input.path : null;
}

function contentFields(
	input: Record<string, unknown>,
): Pick<ObsidianVaultChange, "content"> {
	return typeof input.content === "string" && input.content
		? { content: input.content }
		: {};
}

function parseRunCommand(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const commandId = typeof input.id === "string" ? input.id : null;
	if (!commandId) return null;
	const activeBefore =
		typeof result?.activeBefore === "string" && result.activeBefore
			? result.activeBefore
			: null;
	const activeAfter =
		typeof result?.activeAfter === "string" && result.activeAfter
			? result.activeAfter
			: null;
	return {
		id,
		kind: "command",
		commandId,
		...(activeBefore ? { activeBefore } : {}),
		...(activeAfter ? { activeAfter } : {}),
	};
}

function parseBaseCreate(
	id: string,
	input: Record<string, unknown>,
): ObsidianVaultChange | null {
	const basePath = inputPath(input);
	const name = typeof input.name === "string" ? input.name : null;
	if (!basePath || !name) return null;
	return {
		id,
		kind: "base",
		summary: `${name} via ${basePath}`,
		...contentFields(input),
	};
}

function parseTaskUpdate(
	id: string,
	input: Record<string, unknown>,
): ObsidianVaultChange | null {
	const path = inputPath(input);
	const line = typeof input.line === "number" ? input.line : null;
	const action = typeof input.action === "string" ? input.action : null;
	if (!path || line === null || !action) return null;
	const status = typeof input.status === "string" ? input.status : null;
	return {
		id,
		kind: "task",
		path,
		summary: `${path}:${line} · ${action === "status" && status ? `status ${status}` : action}`,
	};
}

function parsePropertySet(
	id: string,
	input: Record<string, unknown>,
): ObsidianVaultChange | null {
	const path = inputPath(input);
	const name = typeof input.name === "string" ? input.name : null;
	if (!path || !name) return null;
	return {
		id,
		kind: "property-set",
		path,
		summary: `${path} · ${name} = ${inlineValue(input.value)}`,
	};
}

function parsePropertyRemove(
	id: string,
	input: Record<string, unknown>,
): ObsidianVaultChange | null {
	const path = inputPath(input);
	const name = typeof input.name === "string" ? input.name : null;
	if (!path || !name) return null;
	return {
		id,
		kind: "property-remove",
		path,
		summary: `${path} · removed ${name}`,
	};
}

function parsePatchNote(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const replacements = Array.isArray(input.replacements)
		? input.replacements
		: [];
	const path = resultPath(result) ?? inputPath(input);
	if (!path || replacements.length === 0) return null;
	return {
		id,
		kind: "patched",
		path,
		summary: `${path} · ${replacements.length} replacements`,
		previousContent: patchContent(replacements, "oldText"),
		content: patchContent(replacements, "newText"),
	};
}

function parseTrashFile(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const path = resultPath(result) ?? inputPath(input);
	return path ? { id, kind: "trashed", path, summary: path } : null;
}

function noteChange(
	id: string,
	kind: VaultChangeKind,
	path: string | null,
	input: Record<string, unknown>,
	from?: string | null,
): ObsidianVaultChange | null {
	if (!path) return null;
	return {
		id,
		kind,
		path,
		...(from && from !== path ? { from } : {}),
		...contentFields(input),
	};
}

function parseCreateNote(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	return noteChange(
		id,
		"created",
		resultPath(result) ?? inputPath(input),
		input,
	);
}

function parseCaptureNote(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	return noteChange(id, "created", resultPath(result), input);
}

function pathTarget(
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): string | null {
	return (
		resultPath(result) ?? (input.target === "path" ? inputPath(input) : null)
	);
}

function parseAppendNote(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	return noteChange(id, "appended", pathTarget(input, result), input);
}

function parsePrependNote(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	return noteChange(id, "prepended", pathTarget(input, result), input);
}

function parseReplaceNoteText(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const change = noteChange(id, "replaced", resultPath(result), input);
	if (!change) return null;
	return {
		...change,
		...(typeof input.oldText === "string" && input.oldText
			? { previousContent: input.oldText }
			: {}),
		...(typeof input.newText === "string" ? { content: input.newText } : {}),
	};
}

function parseMoveFile(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const source = inputPath(input);
	const path =
		resultPath(result) ?? (typeof input.to === "string" ? input.to : null);
	return noteChange(id, "moved", path, input, source);
}

function parseRenameFile(
	id: string,
	input: Record<string, unknown>,
	result: Record<string, unknown> | null,
): ObsidianVaultChange | null {
	const source = inputPath(input);
	const path =
		resultPath(result) ??
		(source && typeof input.name === "string"
			? renamedPath(source, input.name)
			: null);
	return noteChange(id, "renamed", path, input, source);
}

const OPERATION_PARSERS: Record<VaultOperation, VaultChangeParser> = {
	create_note: parseCreateNote,
	capture_note: parseCaptureNote,
	append_note: parseAppendNote,
	prepend_note: parsePrependNote,
	replace_note_text: parseReplaceNoteText,
	patch_note: parsePatchNote,
	move_file: parseMoveFile,
	rename_file: parseRenameFile,
	trash_file: parseTrashFile,
	base_create: parseBaseCreate,
	task_update: parseTaskUpdate,
	property_set: parsePropertySet,
	property_remove: parsePropertyRemove,
	run_command: parseRunCommand,
};

export function obsidianVaultChanges(
	toolEvents: ToolEventMessage[],
): ObsidianVaultChange[] {
	return toolEvents.flatMap<ObsidianVaultChange>((event) => {
		const operation = operationFromToolName(event.name);
		if (
			!operation ||
			event.isError ||
			typeof event.result !== "string" ||
			resultIndicatesFailure(event.result)
		) {
			return [];
		}
		const change = OPERATION_PARSERS[operation](
			event.id,
			record(event.input),
			resultRecord(event.result),
		);
		return change ? [change] : [];
	});
}
