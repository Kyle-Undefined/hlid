const STORAGE_KEY = "hlid:pwa-lifecycle-diagnostics:v1";
const MAX_COUNT = 1_000_000;

export const PWA_LIFECYCLE_EVENT_TYPES = [
	"cold_boot",
	"hidden",
	"freeze",
	"resume",
	"service_worker_update",
	"notification_navigation",
] as const;

export type PwaLifecycleEventType = (typeof PWA_LIFECYCLE_EVENT_TYPES)[number];

export type PwaLifecycleEventDiagnostic = {
	count: number;
	lastAt: number | null;
};

export type PwaLifecycleDiagnostics = {
	version: 1;
	lastBootWasDiscarded: boolean | null;
	events: Record<PwaLifecycleEventType, PwaLifecycleEventDiagnostic>;
};

type DiagnosticsStorage = Pick<Storage, "getItem" | "setItem">;

function emptyEvent(): PwaLifecycleEventDiagnostic {
	return { count: 0, lastAt: null };
}

function emptyDiagnostics(): PwaLifecycleDiagnostics {
	return {
		version: 1,
		lastBootWasDiscarded: null,
		events: {
			cold_boot: emptyEvent(),
			hidden: emptyEvent(),
			freeze: emptyEvent(),
			resume: emptyEvent(),
			service_worker_update: emptyEvent(),
			notification_navigation: emptyEvent(),
		},
	};
}

function boundedCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? Math.min(value, MAX_COUNT)
		: 0;
}

function boundedTimestamp(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function parseDiagnostics(value: unknown): PwaLifecycleDiagnostics {
	const fallback = emptyDiagnostics();
	if (typeof value !== "object" || value === null) return fallback;
	const candidate = value as {
		version?: unknown;
		lastBootWasDiscarded?: unknown;
		events?: unknown;
	};
	if (
		candidate.version !== 1 ||
		typeof candidate.events !== "object" ||
		candidate.events === null
	)
		return fallback;
	const events = candidate.events as Record<string, unknown>;
	for (const type of PWA_LIFECYCLE_EVENT_TYPES) {
		const stored = events[type];
		if (typeof stored !== "object" || stored === null) continue;
		const event = stored as { count?: unknown; lastAt?: unknown };
		fallback.events[type] = {
			count: boundedCount(event.count),
			lastAt: boundedTimestamp(event.lastAt),
		};
	}
	if (
		typeof candidate.lastBootWasDiscarded === "boolean" ||
		candidate.lastBootWasDiscarded === null
	)
		fallback.lastBootWasDiscarded = candidate.lastBootWasDiscarded;
	return fallback;
}

function browserStorage(): DiagnosticsStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Read the bounded, content-free lifecycle counters stored by this browser. */
export function readPwaLifecycleDiagnostics(
	storage: DiagnosticsStorage | null = browserStorage(),
): PwaLifecycleDiagnostics {
	if (!storage) return emptyDiagnostics();
	try {
		const raw = storage.getItem(STORAGE_KEY);
		return raw ? parseDiagnostics(JSON.parse(raw)) : emptyDiagnostics();
	} catch {
		return emptyDiagnostics();
	}
}

export function recordPwaLifecycleEvent(
	type: PwaLifecycleEventType,
	options: {
		storage?: DiagnosticsStorage | null;
		now?: number;
		wasDiscarded?: boolean | null;
	} = {},
): PwaLifecycleDiagnostics {
	const storage =
		options.storage === undefined ? browserStorage() : options.storage;
	const diagnostics = readPwaLifecycleDiagnostics(storage);
	const now = boundedTimestamp(options.now ?? Date.now()) ?? Date.now();
	const previous = diagnostics.events[type];
	diagnostics.events[type] = {
		count: Math.min(previous.count + 1, MAX_COUNT),
		lastAt: now,
	};
	if (type === "cold_boot") {
		diagnostics.lastBootWasDiscarded =
			typeof options.wasDiscarded === "boolean" ? options.wasDiscarded : null;
	}
	if (storage) {
		try {
			storage.setItem(STORAGE_KEY, JSON.stringify(diagnostics));
		} catch {
			// Private mode and exhausted storage must not affect app startup.
		}
	}
	return diagnostics;
}

/** Browsers expose Document.wasDiscarded inconsistently; unknown stays null. */
export function documentWasDiscarded(value: unknown): boolean | null {
	if (typeof value !== "object" || value === null) return null;
	const discarded = (value as { wasDiscarded?: unknown }).wasDiscarded;
	return typeof discarded === "boolean" ? discarded : null;
}
