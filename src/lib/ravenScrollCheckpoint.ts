const STORAGE_PREFIX = "hlid:raven-scroll:v1:";
const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_ABSOLUTE_OFFSET_PX = 100_000;

export type RavenScrollCheckpoint = {
	version: 1;
	messageId: string;
	offsetPx: number;
	savedAt: number;
};

type CheckpointStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): CheckpointStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

function storageKey(sessionId: string): string | null {
	if (!sessionId || sessionId.length > 512) return null;
	return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

function boundedMessageId(value: unknown): string | null {
	const hasControlCharacter = (input: string) => {
		for (let index = 0; index < input.length; index++) {
			const code = input.charCodeAt(index);
			if (code <= 31 || code === 127) return true;
		}
		return false;
	};
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_MESSAGE_ID_LENGTH &&
		!hasControlCharacter(value)
		? value
		: null;
}

function boundedOffset(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		Math.abs(value) <= MAX_ABSOLUTE_OFFSET_PX
		? Math.round(value * 100) / 100
		: null;
}

/** Read one bounded, recent transcript anchor. Corrupt and stale values are
 * removed so they cannot repeatedly interfere with Raven startup. */
export function readRavenScrollCheckpoint(
	sessionId: string,
	storage: CheckpointStorage | null = browserStorage(),
	now = Date.now(),
): RavenScrollCheckpoint | null {
	const key = storageKey(sessionId);
	if (!storage || !key || !Number.isSafeInteger(now) || now < 0) return null;
	try {
		const raw = storage.getItem(key);
		if (!raw || raw.length > 2_048) return null;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const messageId = boundedMessageId(parsed.messageId);
		const offsetPx = boundedOffset(parsed.offsetPx);
		const savedAt = parsed.savedAt;
		if (
			parsed.version !== 1 ||
			!messageId ||
			offsetPx === null ||
			typeof savedAt !== "number" ||
			!Number.isSafeInteger(savedAt) ||
			savedAt < 0 ||
			savedAt > now ||
			now - savedAt > CHECKPOINT_MAX_AGE_MS
		) {
			storage.removeItem(key);
			return null;
		}
		return { version: 1, messageId, offsetPx, savedAt };
	} catch {
		try {
			storage.removeItem(key);
		} catch {}
		return null;
	}
}

export function writeRavenScrollCheckpoint(
	sessionId: string,
	anchor: Pick<RavenScrollCheckpoint, "messageId" | "offsetPx">,
	storage: CheckpointStorage | null = browserStorage(),
	now = Date.now(),
): boolean {
	const key = storageKey(sessionId);
	const messageId = boundedMessageId(anchor.messageId);
	const offsetPx = boundedOffset(anchor.offsetPx);
	if (
		!storage ||
		!key ||
		!messageId ||
		offsetPx === null ||
		!Number.isSafeInteger(now) ||
		now < 0
	)
		return false;
	try {
		storage.setItem(
			key,
			JSON.stringify({ version: 1, messageId, offsetPx, savedAt: now }),
		);
		return true;
	} catch {
		return false;
	}
}

export function clearRavenScrollCheckpoint(
	sessionId: string,
	storage: CheckpointStorage | null = browserStorage(),
): void {
	const key = storageKey(sessionId);
	if (!storage || !key) return;
	try {
		storage.removeItem(key);
	} catch {}
}

function rowElement(wrapper: HTMLElement): HTMLElement | null {
	// MessageList deliberately uses display:contents wrappers so the checkpoint
	// marker does not alter transcript layout. A wrapper with no child represents
	// a folded/non-rendering card and cannot provide a meaningful visual anchor.
	return wrapper.firstElementChild as HTMLElement | null;
}

/** Capture the first transcript row crossing the visible top edge. */
export function findRavenScrollAnchor(
	scroller: HTMLElement,
): Pick<RavenScrollCheckpoint, "messageId" | "offsetPx"> | null {
	const scrollerRect = scroller.getBoundingClientRect();
	for (const wrapper of scroller.querySelectorAll<HTMLElement>(
		"[data-raven-message-id]",
	)) {
		const messageId = boundedMessageId(wrapper.dataset.ravenMessageId);
		const row = rowElement(wrapper);
		if (!messageId || !row) continue;
		const rowRect = row.getBoundingClientRect();
		if (rowRect.bottom <= scrollerRect.top) continue;
		if (rowRect.top >= scrollerRect.bottom) break;
		return {
			messageId,
			offsetPx: Math.max(
				-MAX_ABSOLUTE_OFFSET_PX,
				Math.min(MAX_ABSOLUTE_OFFSET_PX, rowRect.top - scrollerRect.top),
			),
		};
	}
	return null;
}

/** Re-align a mounted transcript row to its saved visual offset. */
export function restoreRavenScrollAnchor(
	scroller: HTMLElement,
	checkpoint: Pick<RavenScrollCheckpoint, "messageId" | "offsetPx">,
): boolean {
	const messageId = boundedMessageId(checkpoint.messageId);
	const offsetPx = boundedOffset(checkpoint.offsetPx);
	if (!messageId || offsetPx === null) return false;
	const wrapper = Array.from(
		scroller.querySelectorAll<HTMLElement>("[data-raven-message-id]"),
	).find((candidate) => candidate.dataset.ravenMessageId === messageId);
	const row = wrapper ? rowElement(wrapper) : null;
	if (!row) return false;
	const scrollerTop = scroller.getBoundingClientRect().top;
	const delta = row.getBoundingClientRect().top - scrollerTop - offsetPx;
	if (!Number.isFinite(delta)) return false;
	scroller.scrollTop += delta;
	return true;
}

export const RAVEN_SCROLL_RESTORE_MAX_PAGES = 5;
