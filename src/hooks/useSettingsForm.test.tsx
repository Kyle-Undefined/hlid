// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { type SettingsInitial, useSettingsForm } from "./useSettingsForm";

function initialSettings(): SettingsInitial {
	return {
		...HlidConfigSchema.parse({}),
		cwd: "/vault",
		providers: [],
		accountInfo: null,
		voiceInfo: {
			status: { state: "disabled", model: "" },
			models: [],
		},
		acpCatalog: [],
	};
}

async function advance(milliseconds: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useSettingsForm autosave", () => {
	it("does not save unchanged initial forms", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		renderHook(() => useSettingsForm(initialSettings(), vi.fn()));
		await advance(1_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("debounces repeated edits into one ordinary save", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const onSaved = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), onSaved),
		);
		act(() =>
			result.current.setVoice({ ...result.current.voice, enabled: true }),
		);
		await advance(500);
		act(() =>
			result.current.setVoice({ ...result.current.voice, language: "en" }),
		);
		await advance(799);
		expect(fetchMock).not.toHaveBeenCalled();
		await advance(1);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(onSaved).toHaveBeenCalledOnce();
		expect(result.current.savedMsg).toBe("saved");
		expect(result.current.saving).toBe(false);
	});

	it("marks server and ACP changes as requiring restart", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn().mockResolvedValue(undefined)),
		);
		act(() =>
			result.current.setServer({ ...result.current.server, port: "4100" }),
		);
		await advance(800);
		expect(result.current.savedMsg).toBe("restart");
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body.server.port).toBe(4100);
	});

	it("shows the server error and preserves edited state", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ error: "configuration rejected" }, { status: 400 }),
				),
		);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn()),
		);
		act(() =>
			result.current.setVoice({ ...result.current.voice, enabled: true }),
		);
		await advance(800);
		expect(result.current.error).toBe("configuration rejected");
		expect(result.current.voice.enabled).toBe(true);
		expect(result.current.saving).toBe(false);
	});

	it("uses a stable fallback for invalid error bodies and network failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("not json", { status: 500 }))
			.mockRejectedValueOnce("offline");
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn()),
		);
		act(() => result.current.setUi({ ...result.current.ui, htmlPlans: true }));
		await advance(800);
		expect(result.current.error).toBe("Save failed");
		act(() =>
			result.current.setUi({ ...result.current.ui, enterToSubmit: false }),
		);
		await advance(800);
		expect(result.current.error).toBe("Save failed");
		expect(result.current.ui.enterToSubmit).toBe(false);
	});

	it("manual save cancels the pending autosave instead of submitting twice", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn().mockResolvedValue(undefined)),
		);
		act(() =>
			result.current.setVoice({ ...result.current.voice, enabled: true }),
		);
		await advance(400);
		await act(async () => result.current.save());
		await advance(1_000);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
