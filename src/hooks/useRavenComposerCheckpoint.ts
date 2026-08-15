import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import type { VaultReferenceSelections } from "#/hooks/useVaultReferencePicker";
import {
	MAX_COMPOSER_REFERENCES,
	MAX_RELIC_REFERENCES,
	MAX_VAULT_REFERENCES,
	MAX_WORKSPACE_REFERENCES,
	type RelicReferenceItem,
	type VaultReferenceItem,
	type WorkspaceReferenceSelection,
} from "#/lib/vaultReferences";
import type { ChatAttachment } from "#/server/protocol";

const CHECKPOINT_VERSION = 1 as const;
const CHECKPOINT_STORAGE_PREFIX = "hlid:raven-composer:v1:";
const MAX_CHECKPOINT_BYTES = 64 * 1_024;
const MAX_DRAFT_KEY_LENGTH = 256;
const MAX_ATTACHMENT_COUNT = 32;
const MAX_PATH_LENGTH = 4_096;
const MAX_NAME_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_KIND_LENGTH = 128;
const MAX_WORKSPACE_FILE_BYTES = 1_099_511_627_776;

export type RavenComposerCheckpointData = {
	attachments: ChatAttachment[];
	vaultReferences: VaultReferenceItem[];
	relicReferences: RelicReferenceItem[];
	workspaceReferences: WorkspaceReferenceSelection[];
};

type StoredRavenComposerCheckpoint = RavenComposerCheckpointData & {
	version: typeof CHECKPOINT_VERSION;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): UnknownRecord | null {
	if (!isRecord(value)) return null;
	const allowed = new Set([...required, ...optional]);
	if (required.some((key) => !Object.hasOwn(value, key))) return null;
	if (Object.keys(value).some((key) => !allowed.has(key))) return null;
	return value;
}

function boundedString(
	value: unknown,
	maxLength: number,
	allowEmpty = false,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= maxLength &&
		!value.includes("\0")
	);
}

function boundedInteger(value: unknown, maximum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= maximum
	);
}

function parseArray<T>(
	value: unknown,
	maximum: number,
	parseItem: (item: unknown) => T | null,
): T[] | null {
	if (!Array.isArray(value) || value.length > maximum) return null;
	const parsed: T[] = [];
	for (const item of value) {
		const parsedItem = parseItem(item);
		if (parsedItem === null) return null;
		parsed.push(parsedItem);
	}
	return parsed;
}

function parseAttachment(value: unknown): ChatAttachment | null {
	const record = exactRecord(value, ["id", "path", "filename", "mime", "kind"]);
	if (
		!record ||
		!boundedString(record.id, MAX_LABEL_LENGTH) ||
		!boundedString(record.path, MAX_PATH_LENGTH) ||
		!boundedString(record.filename, MAX_NAME_LENGTH) ||
		!boundedString(record.mime, MAX_LABEL_LENGTH) ||
		!boundedString(record.kind, MAX_KIND_LENGTH)
	) {
		return null;
	}
	return {
		id: record.id,
		path: record.path,
		filename: record.filename,
		mime: record.mime,
		kind: record.kind,
	};
}

function parseVaultReference(value: unknown): VaultReferenceItem | null {
	const record = exactRecord(value, ["relativePath", "name", "directory"]);
	if (
		!record ||
		!boundedString(record.relativePath, MAX_PATH_LENGTH) ||
		!boundedString(record.name, MAX_NAME_LENGTH) ||
		!boundedString(record.directory, MAX_PATH_LENGTH, true)
	) {
		return null;
	}
	return {
		relativePath: record.relativePath,
		name: record.name,
		directory: record.directory,
	};
}

function parseRelicReference(value: unknown): RelicReferenceItem | null {
	const record = exactRecord(
		value,
		["id", "path", "filename", "mime", "kind", "createdAt", "category"],
		["sessionId"],
	);
	if (
		!record ||
		!boundedString(record.id, MAX_LABEL_LENGTH) ||
		!boundedString(record.path, MAX_PATH_LENGTH) ||
		!boundedString(record.filename, MAX_NAME_LENGTH) ||
		!boundedString(record.mime, MAX_LABEL_LENGTH) ||
		!boundedString(record.kind, MAX_KIND_LENGTH) ||
		!boundedInteger(record.createdAt, Number.MAX_SAFE_INTEGER) ||
		!boundedString(record.category, MAX_KIND_LENGTH) ||
		(record.sessionId !== undefined &&
			record.sessionId !== null &&
			!boundedString(record.sessionId, MAX_LABEL_LENGTH))
	) {
		return null;
	}
	return {
		id: record.id,
		path: record.path,
		filename: record.filename,
		mime: record.mime,
		kind: record.kind,
		createdAt: record.createdAt,
		category: record.category,
		...(record.sessionId !== undefined
			? { sessionId: record.sessionId as string | null }
			: {}),
	};
}

function parseWorkspaceReference(
	value: unknown,
): WorkspaceReferenceSelection | null {
	const record = exactRecord(value, [
		"relativePath",
		"name",
		"directory",
		"sha256",
		"sizeBytes",
		"environment",
		"environmentLabel",
		"previewKind",
		"mime",
	]);
	if (
		!record ||
		!boundedString(record.relativePath, MAX_PATH_LENGTH) ||
		!boundedString(record.name, MAX_NAME_LENGTH) ||
		!boundedString(record.directory, MAX_PATH_LENGTH, true) ||
		typeof record.sha256 !== "string" ||
		!/^[a-f\d]{64}$/i.test(record.sha256) ||
		!boundedInteger(record.sizeBytes, MAX_WORKSPACE_FILE_BYTES) ||
		(record.environment !== "host" &&
			record.environment !== "windows" &&
			record.environment !== "wsl") ||
		!boundedString(record.environmentLabel, MAX_LABEL_LENGTH) ||
		(record.previewKind !== "text" && record.previewKind !== "image") ||
		!boundedString(record.mime, MAX_LABEL_LENGTH)
	) {
		return null;
	}
	return {
		relativePath: record.relativePath,
		name: record.name,
		directory: record.directory,
		sha256: record.sha256,
		sizeBytes: record.sizeBytes,
		environment: record.environment,
		environmentLabel: record.environmentLabel,
		previewKind: record.previewKind,
		mime: record.mime,
	};
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): boolean {
	return new Set(items.map(key)).size === items.length;
}

function parseStoredCheckpoint(
	value: unknown,
): StoredRavenComposerCheckpoint | null {
	const record = exactRecord(value, [
		"version",
		"attachments",
		"vaultReferences",
		"relicReferences",
		"workspaceReferences",
	]);
	if (!record || record.version !== CHECKPOINT_VERSION) return null;
	const attachments = parseArray(
		record.attachments,
		MAX_ATTACHMENT_COUNT,
		parseAttachment,
	);
	const vaultReferences = parseArray(
		record.vaultReferences,
		MAX_VAULT_REFERENCES,
		parseVaultReference,
	);
	const relicReferences = parseArray(
		record.relicReferences,
		MAX_RELIC_REFERENCES,
		parseRelicReference,
	);
	const workspaceReferences = parseArray(
		record.workspaceReferences,
		MAX_WORKSPACE_REFERENCES,
		parseWorkspaceReference,
	);
	if (
		!attachments ||
		!vaultReferences ||
		!relicReferences ||
		!workspaceReferences ||
		vaultReferences.length +
			relicReferences.length +
			workspaceReferences.length >
			MAX_COMPOSER_REFERENCES ||
		!uniqueBy(attachments, (item) => item.id) ||
		!uniqueBy(vaultReferences, (item) => item.relativePath) ||
		!uniqueBy(relicReferences, (item) => item.id) ||
		!uniqueBy(workspaceReferences, (item) => item.relativePath)
	) {
		return null;
	}
	return {
		version: CHECKPOINT_VERSION,
		attachments,
		vaultReferences,
		relicReferences,
		workspaceReferences,
	};
}

function pickRecord(value: unknown): UnknownRecord {
	return isRecord(value) ? value : {};
}

function storedCheckpointFromData(
	data: RavenComposerCheckpointData,
): StoredRavenComposerCheckpoint | null {
	if (
		!Array.isArray(data.attachments) ||
		!Array.isArray(data.vaultReferences) ||
		!Array.isArray(data.relicReferences) ||
		!Array.isArray(data.workspaceReferences)
	) {
		return null;
	}
	const attachments = data.attachments.flatMap((value) => {
		const record = pickRecord(value);
		if (Object.hasOwn(record, "reference")) return [];
		return [
			{
				id: record.id,
				path: record.path,
				filename: record.filename,
				mime: record.mime,
				kind: record.kind,
			},
		];
	});
	const vaultReferences = data.vaultReferences.map((value) => {
		const record = pickRecord(value);
		return {
			relativePath: record.relativePath,
			name: record.name,
			directory: record.directory,
		};
	});
	const relicReferences = data.relicReferences.map((value) => {
		const record = pickRecord(value);
		return {
			id: record.id,
			path: record.path,
			filename: record.filename,
			mime: record.mime,
			kind: record.kind,
			createdAt: record.createdAt,
			category: record.category,
			...(record.sessionId !== undefined
				? { sessionId: record.sessionId }
				: {}),
		};
	});
	const workspaceReferences = data.workspaceReferences.map((value) => {
		const record = pickRecord(value);
		return {
			relativePath: record.relativePath,
			name: record.name,
			directory: record.directory,
			sha256: record.sha256,
			sizeBytes: record.sizeBytes,
			environment: record.environment,
			environmentLabel: record.environmentLabel,
			previewKind: record.previewKind,
			mime: record.mime,
		};
	});
	return parseStoredCheckpoint({
		version: CHECKPOINT_VERSION,
		attachments,
		vaultReferences,
		relicReferences,
		workspaceReferences,
	});
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const point = value.codePointAt(index) ?? 0;
		if (point > 0xffff) index++;
		bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
	}
	return bytes;
}

function checkpointStorage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function ravenComposerCheckpointStorageKey(
	draftKey: string,
): string | null {
	if (
		!draftKey.startsWith("hlid:draft:") ||
		draftKey.length > MAX_DRAFT_KEY_LENGTH ||
		draftKey.includes("\0")
	) {
		return null;
	}
	return `${CHECKPOINT_STORAGE_PREFIX}${encodeURIComponent(draftKey)}`;
}

export function clearRavenComposerCheckpoint(draftKey: string): void {
	const key = ravenComposerCheckpointStorageKey(draftKey);
	const storage = checkpointStorage();
	if (!key || !storage) return;
	try {
		storage.removeItem(key);
	} catch {}
}

export function saveRavenComposerCheckpoint(
	draftKey: string,
	data: RavenComposerCheckpointData,
): boolean {
	const key = ravenComposerCheckpointStorageKey(draftKey);
	const storage = checkpointStorage();
	if (!key || !storage) return false;
	const checkpoint = storedCheckpointFromData(data);
	if (!checkpoint) {
		clearRavenComposerCheckpoint(draftKey);
		return false;
	}
	if (
		checkpoint.attachments.length === 0 &&
		checkpoint.vaultReferences.length === 0 &&
		checkpoint.relicReferences.length === 0 &&
		checkpoint.workspaceReferences.length === 0
	) {
		clearRavenComposerCheckpoint(draftKey);
		return true;
	}
	const serialized = JSON.stringify(checkpoint);
	if (
		serialized.length > MAX_CHECKPOINT_BYTES ||
		utf8ByteLength(serialized) > MAX_CHECKPOINT_BYTES
	) {
		clearRavenComposerCheckpoint(draftKey);
		return false;
	}
	try {
		storage.setItem(key, serialized);
		return true;
	} catch {
		return false;
	}
}

export function loadRavenComposerCheckpoint(
	draftKey: string,
): RavenComposerCheckpointData | null {
	const key = ravenComposerCheckpointStorageKey(draftKey);
	const storage = checkpointStorage();
	if (!key || !storage) return null;
	try {
		const serialized = storage.getItem(key);
		if (!serialized) return null;
		if (
			serialized.length > MAX_CHECKPOINT_BYTES ||
			utf8ByteLength(serialized) > MAX_CHECKPOINT_BYTES
		) {
			storage.removeItem(key);
			return null;
		}
		const checkpoint = parseStoredCheckpoint(JSON.parse(serialized));
		if (!checkpoint) {
			storage.removeItem(key);
			return null;
		}
		return {
			attachments: checkpoint.attachments,
			vaultReferences: checkpoint.vaultReferences,
			relicReferences: checkpoint.relicReferences,
			workspaceReferences: checkpoint.workspaceReferences,
		};
	} catch {
		try {
			storage.removeItem(key);
		} catch {}
		return null;
	}
}

function emptyCheckpoint(): RavenComposerCheckpointData {
	return {
		attachments: [],
		vaultReferences: [],
		relicReferences: [],
		workspaceReferences: [],
	};
}

function checkpointHasData(checkpoint: RavenComposerCheckpointData): boolean {
	return (
		checkpoint.attachments.length > 0 ||
		checkpoint.vaultReferences.length > 0 ||
		checkpoint.relicReferences.length > 0 ||
		checkpoint.workspaceReferences.length > 0
	);
}

function checkpointSignature(
	checkpoint: RavenComposerCheckpointData,
): string | null {
	const stored = storedCheckpointFromData(checkpoint);
	return stored ? JSON.stringify(stored) : null;
}

export function useRavenComposerCheckpoint({
	draftKey,
	attachments,
	setAttachments,
	clearAttachments,
	vaultReferences,
	relicReferences,
	workspaceReferences,
	replaceReferences,
}: {
	draftKey: string;
	attachments: ChatAttachment[];
	setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
	clearAttachments?: () => void;
	vaultReferences: VaultReferenceItem[];
	relicReferences: RelicReferenceItem[];
	workspaceReferences: WorkspaceReferenceSelection[];
	replaceReferences: (selections: VaultReferenceSelections) => void;
}) {
	const renderedSnapshot = useMemo<RavenComposerCheckpointData>(
		() => ({
			attachments,
			vaultReferences,
			relicReferences,
			workspaceReferences,
		}),
		[attachments, relicReferences, vaultReferences, workspaceReferences],
	);
	const latestSnapshotRef = useRef(renderedSnapshot);
	latestSnapshotRef.current = renderedSnapshot;
	const activeSnapshotRef = useRef<RavenComposerCheckpointData>(
		emptyCheckpoint(),
	);
	const activeKeyRef = useRef<string | null>(null);
	const pendingRestoreSignatureRef = useRef<string | undefined>(undefined);
	const clearedKeyRef = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (activeKeyRef.current === draftKey) return;
		const previousKey = activeKeyRef.current;
		if (previousKey && clearedKeyRef.current !== previousKey) {
			const previousSnapshot =
				pendingRestoreSignatureRef.current === undefined
					? latestSnapshotRef.current
					: activeSnapshotRef.current;
			saveRavenComposerCheckpoint(previousKey, previousSnapshot);
		}

		const restored = loadRavenComposerCheckpoint(draftKey) ?? emptyCheckpoint();
		activeKeyRef.current = draftKey;
		activeSnapshotRef.current = restored;
		pendingRestoreSignatureRef.current =
			checkpointSignature(restored) ?? undefined;
		clearedKeyRef.current = null;
		setAttachments(restored.attachments);
		replaceReferences({
			vault: restored.vaultReferences,
			relics: restored.relicReferences,
			workspace: restored.workspaceReferences,
		});
	}, [draftKey, replaceReferences, setAttachments]);

	useEffect(() => {
		if (activeKeyRef.current !== draftKey) return;
		const signature = checkpointSignature(renderedSnapshot);
		const pendingSignature = pendingRestoreSignatureRef.current;
		if (pendingSignature !== undefined) {
			if (signature !== pendingSignature) return;
			pendingRestoreSignatureRef.current = undefined;
			activeSnapshotRef.current = renderedSnapshot;
			return;
		}
		if (clearedKeyRef.current === draftKey) {
			activeSnapshotRef.current = renderedSnapshot;
			if (!checkpointHasData(renderedSnapshot)) return;
			clearedKeyRef.current = null;
		}
		activeSnapshotRef.current = renderedSnapshot;
		saveRavenComposerCheckpoint(draftKey, renderedSnapshot);
	}, [draftKey, renderedSnapshot]);

	const flushRef = useRef<() => void>(() => {});
	flushRef.current = () => {
		const activeKey = activeKeyRef.current;
		if (!activeKey || clearedKeyRef.current === activeKey) return;
		const snapshot =
			pendingRestoreSignatureRef.current === undefined
				? latestSnapshotRef.current
				: activeSnapshotRef.current;
		saveRavenComposerCheckpoint(activeKey, snapshot);
	};
	useEffect(() => {
		const flush = () => flushRef.current();
		const flushWhenHidden = () => {
			if (document.visibilityState === "hidden") flush();
		};
		document.addEventListener("visibilitychange", flushWhenHidden);
		window.addEventListener("pagehide", flush);
		document.addEventListener("freeze", flush);
		return () => {
			document.removeEventListener("visibilitychange", flushWhenHidden);
			window.removeEventListener("pagehide", flush);
			document.removeEventListener("freeze", flush);
			flush();
		};
	}, []);

	const clear = useCallback(() => {
		const activeKey = activeKeyRef.current ?? draftKey;
		clearRavenComposerCheckpoint(activeKey);
		clearedKeyRef.current = activeKey;
		pendingRestoreSignatureRef.current = undefined;
		const empty = emptyCheckpoint();
		activeSnapshotRef.current = empty;
		latestSnapshotRef.current = empty;
		if (clearAttachments) clearAttachments();
		else setAttachments([]);
		replaceReferences({ vault: [], relics: [], workspace: [] });
	}, [clearAttachments, draftKey, replaceReferences, setAttachments]);

	return { clear };
}
