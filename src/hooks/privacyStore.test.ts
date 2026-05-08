/**
 * privacyStore — module-level state machine + pub/sub.
 * Browser APIs (localStorage, document) are stubbed globally.
 * Module is re-imported fresh each test via vi.resetModules() to avoid
 * state bleed from _privacy and _subscribers module-level variables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── browser API stubs ─────────────────────────────────────────────────────────

const localStorageStore: Record<string, string> = {};
const localStorageMock = {
	getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
	setItem: vi.fn((key: string, val: string) => {
		localStorageStore[key] = val;
	}),
	removeItem: vi.fn((key: string) => {
		delete localStorageStore[key];
	}),
};

const setAttributeMock = vi.fn();
const documentMock = {
	documentElement: { setAttribute: setAttributeMock },
};

vi.stubGlobal("localStorage", localStorageMock);
vi.stubGlobal("document", documentMock);

// ── fresh module per test ─────────────────────────────────────────────────────

type PrivacyStore = typeof import("./privacyStore");

let store: PrivacyStore;

beforeEach(async () => {
	// Clear localStorage state
	for (const key of Object.keys(localStorageStore)) {
		delete localStorageStore[key];
	}
	vi.clearAllMocks();
	vi.resetModules();
	store = await import("./privacyStore");
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── getSnapshot ───────────────────────────────────────────────────────────────

describe("getSnapshot", () => {
	it("returns false initially", () => {
		expect(store.getSnapshot()).toBe(false);
	});
});

// ── togglePrivacy ─────────────────────────────────────────────────────────────

describe("togglePrivacy", () => {
	it("flips false → true", () => {
		store.togglePrivacy();
		expect(store.getSnapshot()).toBe(true);
	});

	it("flips true → false", () => {
		store.togglePrivacy();
		store.togglePrivacy();
		expect(store.getSnapshot()).toBe(false);
	});

	it('persists "on" to localStorage when toggled true', () => {
		store.togglePrivacy();
		expect(localStorageMock.setItem).toHaveBeenCalledWith("hlid:privacy", "on");
	});

	it('persists "off" to localStorage when toggled false', () => {
		store.togglePrivacy(); // → true
		store.togglePrivacy(); // → false
		expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
			"hlid:privacy",
			"off",
		);
	});

	it('sets data-privacy="on" on documentElement when true', () => {
		store.togglePrivacy();
		expect(setAttributeMock).toHaveBeenCalledWith("data-privacy", "on");
	});

	it('sets data-privacy="off" on documentElement when false', () => {
		store.togglePrivacy(); // → true
		store.togglePrivacy(); // → false
		expect(setAttributeMock).toHaveBeenLastCalledWith("data-privacy", "off");
	});
});

// ── initFromStorage ───────────────────────────────────────────────────────────

describe("initFromStorage", () => {
	it('sets privacy true when localStorage has "on"', () => {
		localStorageStore["hlid:privacy"] = "on";
		store.initFromStorage();
		expect(store.getSnapshot()).toBe(true);
	});

	it("sets privacy false when localStorage has other value", () => {
		localStorageStore["hlid:privacy"] = "off";
		store.initFromStorage();
		expect(store.getSnapshot()).toBe(false);
	});

	it("sets privacy false when localStorage key absent", () => {
		store.initFromStorage();
		expect(store.getSnapshot()).toBe(false);
	});

	it("sets data-privacy attribute on documentElement", () => {
		localStorageStore["hlid:privacy"] = "on";
		store.initFromStorage();
		expect(setAttributeMock).toHaveBeenCalledWith("data-privacy", "on");
	});
});

// ── subscribe / notify ────────────────────────────────────────────────────────

describe("subscribe", () => {
	it("calls subscriber when togglePrivacy fires", () => {
		const cb = vi.fn();
		store.subscribe(cb);
		store.togglePrivacy();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("calls subscriber when initFromStorage fires", () => {
		const cb = vi.fn();
		store.subscribe(cb);
		store.initFromStorage();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("unsubscribe removes listener", () => {
		const cb = vi.fn();
		const unsub = store.subscribe(cb);
		unsub();
		store.togglePrivacy();
		expect(cb).not.toHaveBeenCalled();
	});

	it("returns unsubscribe function", () => {
		const unsub = store.subscribe(vi.fn());
		expect(typeof unsub).toBe("function");
	});

	it("notifies multiple subscribers", () => {
		const a = vi.fn();
		const b = vi.fn();
		store.subscribe(a);
		store.subscribe(b);
		store.togglePrivacy();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("only unsubscribes the specific subscriber", () => {
		const a = vi.fn();
		const b = vi.fn();
		const unsubA = store.subscribe(a);
		store.subscribe(b);
		unsubA();
		store.togglePrivacy();
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalledTimes(1);
	});
});
