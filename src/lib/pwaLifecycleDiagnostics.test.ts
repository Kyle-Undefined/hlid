import { describe, expect, it, vi } from "vitest";
import {
	documentWasDiscarded,
	readPwaLifecycleDiagnostics,
	recordPwaLifecycleEvent,
} from "./pwaLifecycleDiagnostics";

function memoryStorage(initial: string | null = null) {
	let stored = initial;
	return {
		getItem: vi.fn(() => stored),
		setItem: vi.fn((_key: string, value: string) => {
			stored = value;
		}),
	};
}

describe("PWA lifecycle diagnostics", () => {
	it("stores only bounded counters, timestamps, and discard state", () => {
		const storage = memoryStorage();
		recordPwaLifecycleEvent("cold_boot", {
			storage,
			now: 1_000,
			wasDiscarded: true,
		});
		recordPwaLifecycleEvent("hidden", { storage, now: 2_000 });
		recordPwaLifecycleEvent("resume", { storage, now: 3_000 });

		expect(readPwaLifecycleDiagnostics(storage)).toMatchObject({
			version: 1,
			lastBootWasDiscarded: true,
			events: {
				cold_boot: { count: 1, lastAt: 1_000 },
				hidden: { count: 1, lastAt: 2_000 },
				resume: { count: 1, lastAt: 3_000 },
				freeze: { count: 0, lastAt: null },
				service_worker_update: { count: 0, lastAt: null },
				notification_navigation: { count: 0, lastAt: null },
			},
		});
		const serialized = storage.setItem.mock.calls.at(-1)?.[1] ?? "";
		expect(serialized).not.toContain("session");
		expect(serialized).not.toContain("prompt");
	});

	it("repairs corrupt and unbounded stored values", () => {
		const storage = memoryStorage(
			JSON.stringify({
				version: 1,
				lastBootWasDiscarded: "yes",
				events: {
					cold_boot: { count: Number.MAX_SAFE_INTEGER, lastAt: -1 },
					resume: { count: "many", lastAt: "recent" },
				},
			}),
		);

		const diagnostics = readPwaLifecycleDiagnostics(storage);
		expect(diagnostics.lastBootWasDiscarded).toBeNull();
		expect(diagnostics.events.cold_boot).toEqual({
			count: 1_000_000,
			lastAt: null,
		});
		expect(diagnostics.events.resume).toEqual({ count: 0, lastAt: null });
	});

	it("is inert when storage is unavailable and tolerates missing wasDiscarded", () => {
		expect(
			recordPwaLifecycleEvent("freeze", {
				storage: null,
				now: 4_000,
			}),
		).toMatchObject({ events: { freeze: { count: 1, lastAt: 4_000 } } });
		expect(documentWasDiscarded({ wasDiscarded: false })).toBe(false);
		expect(documentWasDiscarded({})).toBeNull();
		expect(documentWasDiscarded(null)).toBeNull();
	});
});
