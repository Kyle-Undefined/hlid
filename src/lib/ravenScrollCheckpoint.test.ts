// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearRavenScrollCheckpoint,
	findRavenScrollAnchor,
	readRavenScrollCheckpoint,
	restoreRavenScrollAnchor,
	writeRavenScrollCheckpoint,
} from "./ravenScrollCheckpoint";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => values.set(key, value)),
		removeItem: vi.fn((key: string) => values.delete(key)),
	};
}

function rect(top: number, bottom: number): DOMRect {
	return {
		top,
		bottom,
		left: 0,
		right: 300,
		width: 300,
		height: bottom - top,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("Raven scroll checkpoints", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("round-trips a bounded recent anchor and removes stale data", () => {
		const storage = memoryStorage();
		expect(
			writeRavenScrollCheckpoint(
				"session/one",
				{ messageId: "message-42", offsetPx: -12.346 },
				storage,
				1_000,
			),
		).toBe(true);
		expect(readRavenScrollCheckpoint("session/one", storage, 2_000)).toEqual({
			version: 1,
			messageId: "message-42",
			offsetPx: -12.35,
			savedAt: 1_000,
		});

		expect(
			readRavenScrollCheckpoint(
				"session/one",
				storage,
				8 * 24 * 60 * 60 * 1_000,
			),
		).toBeNull();
		expect(storage.values.size).toBe(0);
	});

	it("rejects malformed and oversized values without throwing", () => {
		const storage = memoryStorage();
		storage.values.set(
			"hlid:raven-scroll:v1:session",
			JSON.stringify({
				version: 1,
				messageId: "x".repeat(513),
				offsetPx: 0,
				savedAt: 1,
			}),
		);
		expect(readRavenScrollCheckpoint("session", storage, 2)).toBeNull();
		expect(
			writeRavenScrollCheckpoint(
				"session",
				{ messageId: "ok", offsetPx: Number.POSITIVE_INFINITY },
				storage,
				2,
			),
		).toBe(false);
	});

	it("captures and restores the first visible message by stable id", () => {
		const scroller = document.createElement("div");
		Object.defineProperty(scroller, "scrollTop", {
			value: 200,
			writable: true,
		});
		scroller.getBoundingClientRect = () => rect(100, 500);
		for (const [id, top, bottom] of [
			["older", 20, 90],
			["anchor", 82, 160],
			["later", 160, 230],
		] as const) {
			const wrapper = document.createElement("div");
			wrapper.dataset.ravenMessageId = id;
			const row = document.createElement("article");
			row.getBoundingClientRect = () => rect(top, bottom);
			wrapper.append(row);
			scroller.append(wrapper);
		}
		document.body.append(scroller);

		expect(findRavenScrollAnchor(scroller)).toEqual({
			messageId: "anchor",
			offsetPx: -18,
		});
		expect(
			restoreRavenScrollAnchor(scroller, {
				messageId: "later",
				offsetPx: 10,
			}),
		).toBe(true);
		expect(scroller.scrollTop).toBe(250);
	});

	it("does not treat a folded display-contents marker as a visual row", () => {
		const scroller = document.createElement("div");
		Object.defineProperty(scroller, "scrollTop", {
			value: 40,
			writable: true,
		});
		scroller.getBoundingClientRect = () => rect(100, 500);
		const wrapper = document.createElement("div");
		wrapper.dataset.ravenMessageId = "folded";
		scroller.append(wrapper);

		expect(findRavenScrollAnchor(scroller)).toBeNull();
		expect(
			restoreRavenScrollAnchor(scroller, {
				messageId: "folded",
				offsetPx: 0,
			}),
		).toBe(false);
		expect(scroller.scrollTop).toBe(40);
	});

	it("clears an exact session without touching another", () => {
		const storage = memoryStorage();
		writeRavenScrollCheckpoint(
			"one",
			{ messageId: "a", offsetPx: 0 },
			storage,
			1,
		);
		writeRavenScrollCheckpoint(
			"two",
			{ messageId: "b", offsetPx: 0 },
			storage,
			1,
		);
		clearRavenScrollCheckpoint("one", storage);
		expect(readRavenScrollCheckpoint("one", storage, 2)).toBeNull();
		expect(readRavenScrollCheckpoint("two", storage, 2)?.messageId).toBe("b");
	});
});
