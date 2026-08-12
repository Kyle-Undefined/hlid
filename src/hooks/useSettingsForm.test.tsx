// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NavigationNamesProvider,
	useNavigationLabels,
} from "#/components/nav/NavigationNamesContext";
import { HlidConfigSchema } from "#/config";
import { resolveNavigationLabels } from "#/lib/navigationNames";
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
		cliProxyInfo: {
			state: "not_installed",
			managed: false,
			authenticated: false,
			oauth: "idle",
			accounts: {
				codex: "idle",
				claude: "idle",
				antigravity: "idle",
				kimi: "idle",
				xai: "idle",
			},
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

	it("publishes saved navigation names into the mounted shell", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const initial = initialSettings();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<StrictMode>
				<NavigationNamesProvider
					initialLabels={resolveNavigationLabels(initial.ui.navigation_names)}
				>
					{children}
				</NavigationNamesProvider>
			</StrictMode>
		);
		const { result } = renderHook(
			() => ({
				form: useSettingsForm(initial, vi.fn().mockResolvedValue(undefined)),
				labels: useNavigationLabels(),
			}),
			{ wrapper },
		);

		act(() =>
			result.current.form.setUi({
				...result.current.form.ui,
				navigationNames: {
					preset: "plain",
					labels: { einherjar: "Workspace" },
				},
			}),
		);
		expect(result.current.labels.einherjar).toBe("AGENTS");

		await advance(800);

		expect(result.current.labels.einherjar).toBe("Workspace");
		expect(result.current.labels.watch).toBe("HOME");
	});

	it("marks server changes as requiring restart", async () => {
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

	it("saves ACP defaults without requiring a restart", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const initial = initialSettings();
		initial.acp_agents = [{ id: "opencode" }];
		const { result } = renderHook(() =>
			useSettingsForm(initial, vi.fn().mockResolvedValue(undefined)),
		);

		act(() =>
			result.current.setAcpAgents([
				{ id: "opencode", model: "anthropic/claude-sonnet-4-6" },
			]),
		);
		await advance(800);

		expect(result.current.savedMsg).toBe("saved");
		expect(
			JSON.parse(fetchMock.mock.calls[0][1].body as string).acp_agents,
		).toEqual([
			expect.objectContaining({
				id: "opencode",
				model: "anthropic/claude-sonnet-4-6",
			}),
		]);
	});

	it("applies ACP process identity changes without requiring a restart", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const initial = initialSettings();
		initial.acp_agents = [{ id: "opencode" }];
		const { result } = renderHook(() =>
			useSettingsForm(initial, vi.fn().mockResolvedValue(undefined)),
		);

		act(() =>
			result.current.setAcpAgents([
				{ id: "opencode", executable: "C:\\tools\\opencode.exe" },
			]),
		);
		await advance(800);

		expect(result.current.savedMsg).toBe("saved");
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
		expect(result.current.dirty).toBe(true);
		expect(result.current.saving).toBe(false);
	});

	it("retries a failed save without requiring another edit", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ error: "temporarily unavailable" }, { status: 503 }),
			)
			.mockResolvedValueOnce(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const onSaved = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), onSaved),
		);
		act(() => result.current.setUi({ ...result.current.ui, htmlPlans: true }));
		await advance(800);
		expect(result.current.error).toBe("temporarily unavailable");
		await act(async () => result.current.save());
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.current.error).toBeNull();
		expect(result.current.dirty).toBe(false);
		expect(onSaved).toHaveBeenCalledOnce();
	});

	it("does not report a successful write as failed when refresh fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const { result } = renderHook(() =>
			useSettingsForm(
				initialSettings(),
				vi.fn().mockRejectedValue(new Error("route refresh failed")),
			),
		);
		act(() => result.current.setUi({ ...result.current.ui, htmlPlans: true }));
		await advance(800);
		expect(result.current.error).toBeNull();
		expect(result.current.dirty).toBe(false);
		expect(result.current.savedMsg).toBe("saved");
	});

	it("records persisted ACP runtime identity even when the follow-up refresh fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const initial = initialSettings();
		initial.acp_agents = [{ id: "opencode" }];
		const { result } = renderHook(() =>
			useSettingsForm(
				initial,
				vi.fn().mockRejectedValue(new Error("route refresh failed")),
			),
		);
		act(() =>
			result.current.setAcpAgents([
				{ id: "opencode", executable: "C:\\tools\\opencode.cmd" },
			]),
		);

		await advance(800);

		expect(result.current.persistedAcpAgents).toEqual([
			{ id: "opencode", executable: "C:\\tools\\opencode.cmd" },
		]);
		expect(result.current.error).toBeNull();
		expect(result.current.savedMsg).toBe("saved");
	});

	it("tracks the persisted ACP discovery workspace after a successful save", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const initial = initialSettings();
		initial.vault.path = "/old-vault";
		const { result } = renderHook(() =>
			useSettingsForm(initial, vi.fn().mockResolvedValue(undefined)),
		);

		act(() =>
			result.current.setVault({ ...result.current.vault, path: "/new-vault" }),
		);
		expect(result.current.persistedVaultPath).toBe("/old-vault");

		await advance(800);

		expect(result.current.persistedVaultPath).toBe("/new-vault");
		expect(result.current.error).toBeNull();
	});

	it("records a newly enabled ACP agent when the follow-up refresh fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		const { result } = renderHook(() =>
			useSettingsForm(
				initialSettings(),
				vi.fn().mockRejectedValue(new Error("route refresh failed")),
			),
		);
		act(() => result.current.setAcpAgents([{ id: "opencode" }]));

		await advance(800);

		expect(result.current.persistedAcpAgents).toEqual([{ id: "opencode" }]);
		expect(result.current.error).toBeNull();
	});

	it("surfaces a runtime warning without marking the persisted save as failed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					ok: true,
					runtime_synced: false,
					warning: "Codex runtime synchronization returned 503.",
				}),
			),
		);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn().mockResolvedValue(undefined)),
		);

		act(() => result.current.setUi({ ...result.current.ui, htmlPlans: true }));
		await advance(800);

		expect(result.current.error).toBeNull();
		expect(result.current.dirty).toBe(false);
		expect(result.current.savedMsg).toBe("saved");
		expect(result.current.warning).toBe(
			"Codex runtime synchronization returned 503.",
		);
	});

	it("keeps ACP runtime identity and workspace pending until an identical retry synchronizes", async () => {
		const warning =
			"ACP runtime synchronization failed: provider registry unavailable.";
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					runtime_synced: false,
					acp_runtime_synced: false,
					warning,
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					ok: true,
					runtime_synced: true,
					acp_runtime_synced: true,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const initial = initialSettings();
		initial.vault.path = "/old-vault";
		initial.acp_agents = [{ id: "opencode" }];
		const onSaved = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ settings }: { settings: SettingsInitial }) =>
				useSettingsForm(settings, onSaved),
			{ initialProps: { settings: initial } },
		);

		act(() => {
			result.current.setVault({
				...result.current.vault,
				path: "/new-vault",
			});
			result.current.setAcpAgents([
				{ id: "opencode", executable: "C:\\tools\\opencode.cmd" },
			]);
		});
		await advance(800);

		expect(result.current.dirty).toBe(false);
		expect(result.current.warning).toBe(warning);
		expect(result.current.acpRuntimePending).toBe(true);
		expect(result.current.persistedVaultPath).toBe("/old-vault");
		expect(result.current.persistedAcpAgents).toEqual([{ id: "opencode" }]);
		rerender({
			settings: {
				...initial,
				vault: { ...initial.vault, path: "/new-vault" },
				acp_agents: [{ id: "opencode", executable: "C:\\tools\\opencode.cmd" }],
			},
		});
		expect(result.current.persistedAcpAgents).toEqual([{ id: "opencode" }]);

		await act(async () => result.current.save());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1].body).toBe(
			fetchMock.mock.calls[0][1].body,
		);
		expect(result.current.acpRuntimePending).toBe(false);
		expect(result.current.persistedVaultPath).toBe("/new-vault");
		expect(result.current.persistedAcpAgents).toEqual([
			{ id: "opencode", executable: "C:\\tools\\opencode.cmd" },
		]);
		expect(result.current.warning).toBeNull();
		expect(onSaved).toHaveBeenCalledTimes(2);
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

	it("queues edits made while a save is in flight and writes the latest form", async () => {
		let resolveFirst: (response: Response) => void = () => {};
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn().mockResolvedValue(undefined)),
		);
		act(() =>
			result.current.setVoice({ ...result.current.voice, enabled: true }),
		);
		await advance(800);
		expect(fetchMock).toHaveBeenCalledOnce();

		act(() =>
			result.current.setVoice({ ...result.current.voice, language: "en" }),
		);
		await advance(800);
		expect(fetchMock).toHaveBeenCalledOnce();

		await act(async () => {
			resolveFirst(Response.json({ ok: true }));
			await firstResponse;
			await Promise.resolve();
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const latest = JSON.parse(fetchMock.mock.calls[1][1].body as string);
		expect(latest.voice).toMatchObject({ enabled: true, language: "en" });
		expect(result.current.dirty).toBe(false);
	});

	it("flushes a pending edit with keepalive when Forge unmounts", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const { result, unmount } = renderHook(() =>
			useSettingsForm(initialSettings(), vi.fn()),
		);
		act(() => result.current.setUi({ ...result.current.ui, htmlPlans: true }));
		await advance(400);
		unmount();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][1]).toEqual(
			expect.objectContaining({ keepalive: true, method: "POST" }),
		);
	});
});
