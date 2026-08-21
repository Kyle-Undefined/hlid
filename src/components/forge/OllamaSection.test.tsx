// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "#/config";
import type { OllamaIntegrationInfo } from "#/server/ollamaIntegration";
import type { OllamaLoadedModel } from "#/server/ollamaManager";

const fns = vi.hoisted(() => ({
	cancel: vi.fn(),
	cancelSetup: vi.fn(),
	delete: vi.fn(),
	get: vi.fn(),
	getSetup: vi.fn(),
	firewall: vi.fn(),
	launchSetup: vi.fn(),
	load: vi.fn(),
	pull: vi.fn(),
	removeFirewall: vi.fn(),
	startSetup: vi.fn(),
	unload: vi.fn(),
}));

vi.mock("#/lib/serverFns/ollama", () => ({
	cancelOllamaWindowsSetupDownloadFn: fns.cancelSetup,
	cancelOllamaPullFn: fns.cancel,
	deleteOllamaModelFn: fns.delete,
	getOllamaInfoFn: fns.get,
	getOllamaWindowsSetupInfoFn: fns.getSetup,
	installOllamaWslFirewallFn: fns.firewall,
	isOllamaIntegrationInfo: (value: unknown) =>
		typeof value === "object" &&
		value !== null &&
		"supported" in value &&
		"models" in value,
	launchOllamaWindowsSetupFn: fns.launchSetup,
	loadOllamaModelFn: fns.load,
	pullOllamaModelFn: fns.pull,
	removeOllamaWslFirewallFn: fns.removeFirewall,
	startOllamaWindowsSetupDownloadFn: fns.startSetup,
	unloadOllamaModelFn: fns.unload,
}));

import {
	OllamaSection,
	type OllamaSectionProps,
	resetOllamaInfoCacheForTesting,
	resetOllamaInfoMemoryCacheForTesting,
} from "./OllamaSection";

type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];

function info(
	overrides: Partial<OllamaIntegrationInfo> = {},
): OllamaIntegrationInfo {
	return {
		supported: true,
		host: "windows",
		status: {
			available: true,
			checkedAt: Date.now(),
			version: "0.32.14",
		},
		setup: { phase: "idle" },
		models: [
			{
				capabilities: ["completion", "tools"],
				compatibilityInspection: { status: "verified", checkedAt: 123_000 },
				details: {
					contextLength: 65_536,
					families: ["qwen3"],
					family: "qwen3",
					format: "gguf",
					parameterSize: "30B",
					parentModel: null,
					quantizationLevel: "Q4_K_M",
				},
				digest: "a".repeat(64),
				model: "qwen3-coder:30b",
				modifiedAt: "2026-08-18T00:00:00Z",
				name: "qwen3-coder:30b",
				size: 8 * 1024 ** 3,
			},
		],
		loadedModels: [],
		preparedModels: [],
		selectedModels: [],
		pull: { state: "idle" },
		firewall: {
			supported: true,
			installed: false,
			exact: false,
			ruleName: "Hlid-Ollama-WSL",
			port: 11435,
		},
		wsl: [],
		relay: { port: 11435, listeners: [] },
		...overrides,
	};
}

function unavailableInfo(
	setup: OllamaIntegrationInfo["setup"] = { phase: "idle" },
): OllamaIntegrationInfo {
	return info({
		status: {
			available: false,
			checkedAt: Date.now(),
			reason: "unavailable",
			version: null,
		},
		setup,
		models: [],
	});
}

function loadedModel(
	model = "qwen3-coder:30b",
	contextLength = 65_536,
): OllamaLoadedModel {
	const local = info().models[0];
	if (!local) throw new Error("missing Ollama model fixture");
	return {
		contextLength,
		details: local.details,
		digest: local.digest,
		expiresAt: null,
		model,
		name: model,
		size: local.size,
		sizeVram: local.size,
	};
}

function renderSection(overrides: Partial<OllamaSectionProps> = {}) {
	const props: OllamaSectionProps = {
		disabled: false,
		onChange: vi.fn(),
		onOpenCodeSetup: vi.fn(),
		...overrides,
	};
	return { ...render(<OllamaSection {...props} />), ...props };
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	resetOllamaInfoCacheForTesting();
});

describe("standalone Windows Ollama integration", () => {
	it("keeps the last inspected inventory visible across Forge navigation", async () => {
		fns.get.mockResolvedValue(info());
		const first = renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		expect(fns.get).toHaveBeenCalledOnce();

		first.unmount();
		renderSection();

		expect(screen.getByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh Ollama" })).toBeTruthy();
		expect(fns.get).toHaveBeenCalledOnce();
	});

	it("restores the last verified inventory after a document reload", async () => {
		fns.get.mockResolvedValue(info());
		const first = renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		first.unmount();
		resetOllamaInfoMemoryCacheForTesting();

		renderSection();

		expect(await screen.findByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh Ollama" })).toBeTruthy();
		expect(fns.get).toHaveBeenCalledOnce();
	});

	it("keeps cached inventory visible when a manual refresh fails", async () => {
		fns.get
			.mockResolvedValueOnce(info())
			.mockRejectedValueOnce(new Error("Windows Ollama inspection failed"));
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Refresh Ollama" }));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"inspection failed",
		);
		expect(screen.getByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
	});

	it("manages downloads and inventory without OpenCode configured", async () => {
		fns.get.mockResolvedValue(info());
		fns.pull.mockResolvedValue({ state: "running" });
		fns.delete.mockResolvedValue({ ok: true });
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		await screen.findByText(/Windows Ollama 0.32.14/i);
		expect(
			screen.getByRole("button", { name: "Set up OpenCode" }),
		).toBeTruthy();

		fireEvent.change(screen.getByLabelText("Exact Ollama model name"), {
			target: { value: "qwen3:8b" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Download model" }));
		await waitFor(() =>
			expect(fns.pull).toHaveBeenCalledWith({ data: "qwen3:8b" }),
		);

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "confirm" }));
		await waitFor(() =>
			expect(fns.delete).toHaveBeenCalledWith({ data: "qwen3-coder:30b" }),
		);
	});

	it("confirms the official installer download and keeps vendor instructions available", async () => {
		fns.get.mockResolvedValue(unavailableInfo());
		fns.startSetup.mockResolvedValue({
			phase: "resolving",
			startedAt: 123_000,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const download = await screen.findByRole("button", {
			name: "Download Ollama installer",
		});
		const instructions = screen.getByRole("link", {
			name: "Open official instructions",
		});
		expect(instructions.getAttribute("href")).toBe(
			"https://ollama.com/download/windows",
		);
		expect(instructions.getAttribute("target")).toBe("_blank");

		fireEvent.click(download);
		expect(fns.startSetup).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				/will not install or run Ollama without another explicit action/i,
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "download" }));

		await waitFor(() => expect(fns.startSetup).toHaveBeenCalledOnce());
	});

	it("shows installer download progress and permits cancel during download", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({
				phase: "downloading",
				startedAt: 123_000,
				version: "0.12.3",
				received: 512,
				total: 2_048,
			}),
		);
		fns.cancelSetup.mockResolvedValue({
			phase: "canceled",
			startedAt: 123_000,
			completedAt: 124_000,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(/Downloading Ollama Setup 0\.12\.3/i),
		).toBeTruthy();
		const progress = screen.getByRole("progressbar") as HTMLProgressElement;
		expect(progress.value).toBe(512);
		expect(progress.max).toBe(2_048);

		fireEvent.click(
			screen.getByRole("button", { name: "Cancel installer download" }),
		);
		await waitFor(() => expect(fns.cancelSetup).toHaveBeenCalledOnce());
	});

	it("shows installer resolution and permits cancel before transfer starts", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({ phase: "resolving", startedAt: 123_000 }),
		);
		fns.cancelSetup.mockResolvedValue({
			phase: "canceled",
			startedAt: 123_000,
			completedAt: 124_000,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(
				/Finding the latest official Ollama Windows installer/i,
			),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel installer download" }),
		);

		await waitFor(() => expect(fns.cancelSetup).toHaveBeenCalledOnce());
	});

	it("does not offer cancel while verifying the installer", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({
				phase: "verifying",
				startedAt: 123_000,
				version: "0.12.3",
				received: 2_048,
				total: 2_048,
			}),
		);
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(/verifying Ollama Setup 0\.12\.3/i),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /cancel installer download/i }),
		).toBeNull();
	});

	it("launches only a ready verified installer after a separate user action", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({
				phase: "ready",
				startedAt: 123_000,
				completedAt: 124_000,
				version: "0.12.3",
				bytes: 2_048,
			}),
		);
		fns.launchSetup.mockResolvedValue({
			phase: "launched",
			startedAt: 123_000,
			launchedAt: 125_000,
			version: "0.12.3",
			bytes: 2_048,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/downloaded and verified/i)).toBeTruthy();
		expect(fns.launchSetup).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Launch Ollama Setup" }),
		);

		await waitFor(() => expect(fns.launchSetup).toHaveBeenCalledOnce());
	});

	it("polls after launch until Windows Ollama is detected", async () => {
		const launched = unavailableInfo({
			phase: "launched",
			startedAt: 123_000,
			launchedAt: 125_000,
			version: "0.12.3",
			bytes: 2_048,
		});
		const detected = info({
			setup: { phase: "complete", version: "0.12.3", detectedAt: 126_000 },
		});
		fns.get.mockResolvedValueOnce(launched).mockResolvedValue(detected);
		fns.getSetup.mockResolvedValue({
			status: detected.status,
			setup: detected.setup,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(/Hlid is waiting for Ollama to answer/i),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Launch Ollama Setup again" }),
		).toBeTruthy();
		expect(
			await screen.findByText(/Windows Ollama 0\.32\.14 detected/i, undefined, {
				timeout: 2_500,
			}),
		).toBeTruthy();
		expect(fns.getSetup).toHaveBeenCalledOnce();
		expect(fns.get).toHaveBeenCalledTimes(2);
	});

	it("uses lightweight setup polling until detection requires full inventory", async () => {
		const downloading = unavailableInfo({
			phase: "downloading",
			startedAt: 123_000,
			version: "0.12.3",
			received: 512,
			total: 2_048,
		});
		const ready = {
			status: downloading.status,
			setup: {
				phase: "ready",
				startedAt: 123_000,
				completedAt: 124_000,
				version: "0.12.3",
				bytes: 2_048,
			} as const,
		};
		fns.get.mockResolvedValue(downloading);
		fns.getSetup.mockResolvedValue(ready);
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/Downloading Ollama Setup/i)).toBeTruthy();
		expect(
			await screen.findByText(/downloaded and verified/i, undefined, {
				timeout: 2_500,
			}),
		).toBeTruthy();
		expect(fns.getSetup).toHaveBeenCalledOnce();
		expect(fns.get).toHaveBeenCalledOnce();
	});

	it("retries retained installer verification without another download confirmation", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({
				phase: "verification_failed",
				startedAt: 123_000,
				completedAt: 124_000,
				version: "0.32.14",
				bytes: 1_564_916_544,
				reason: "Ollama installer signature verification failed",
			}),
		);
		fns.startSetup.mockResolvedValue({
			phase: "verifying",
			startedAt: 123_000,
			version: "0.32.14",
			received: 1_564_916_544,
			total: 1_564_916_544,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(/Windows verification infrastructure failure/i),
		).toBeTruthy();
		expect(
			screen.getByText(/matched the official SHA-256 digest/i),
		).toBeTruthy();
		expect(screen.getByText(/retained this SHA-verified copy/i)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Retry installer verification" }),
		);

		await waitFor(() => expect(fns.startSetup).toHaveBeenCalledOnce());
		expect(screen.queryByRole("button", { name: "download" })).toBeNull();
	});

	it("shows a failed setup reason and confirms a retry", async () => {
		fns.get.mockResolvedValue(
			unavailableInfo({
				phase: "failed",
				startedAt: 123_000,
				completedAt: 124_000,
				reason: "The installer signature did not match Ollama, Inc.",
			}),
		);
		fns.startSetup.mockResolvedValue({
			phase: "resolving",
			startedAt: 125_000,
		});
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(await screen.findByText(/signature did not match/i)).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Retry installer download" }),
		);
		expect(fns.startSetup).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "download" }));

		await waitFor(() => expect(fns.startSetup).toHaveBeenCalledOnce());
	});

	it("shows a retryable inspection error without unsupported-host copy", async () => {
		fns.get
			.mockRejectedValueOnce(
				new Error(
					"Could not inspect Windows Ollama. Hlid could not read the integration status. Try again.",
				),
			)
			.mockResolvedValueOnce(info());
		renderSection();

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Try again",
		);
		expect(
			screen.queryByText(/available when the Hlid server runs on Windows/i),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);

		expect(await screen.findByText(/Windows Ollama 0.32.14/i)).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps genuine unsupported-host status distinct from read errors", async () => {
		fns.get.mockResolvedValue(
			info({
				supported: false,
				status: {
					available: false,
					checkedAt: Date.now(),
					reason: "unavailable",
					version: null,
				},
			}),
		);
		renderSection();

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);

		expect(
			await screen.findByText(
				/available when the Hlid server runs on Windows/i,
			),
		).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps selected models pending and routes to explicit OpenCode setup", async () => {
		fns.get.mockResolvedValue(info());
		const onChange = vi.fn();
		const onOpenCodeSetup = vi.fn();
		renderSection({
			ollama: { models: ["qwen3-coder:30b"], keep_warm: "5m" },
			onChange,
			onOpenCodeSetup,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			(await screen.findAllByText("Selected for OpenCode setup")).length,
		).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole("button", { name: "Set up OpenCode" }));

		expect(onOpenCodeSetup).toHaveBeenCalledOnce();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("treats either Ollama model identity as connected and deletion-blocked", async () => {
		const snapshot = info();
		const baseModel = snapshot.models[0];
		if (!baseModel) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [
				{
					...baseModel,
					model: "canonical:latest",
					name: "friendly:latest",
				},
			],
		});
		const onChange = vi.fn();
		renderSection({
			openCode: { id: "opencode" },
			ollama: { models: ["friendly:latest"], keep_warm: "5m" },
			onChange,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			(
				(await screen.findByRole("button", {
					name: "Delete",
				})) as HTMLButtonElement
			).disabled,
		).toBe(true);
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove from OpenCode" }),
		);

		expect(onChange).toHaveBeenCalledWith(undefined, undefined);
	});

	it("uses unique blocker relationships for tags sharing one digest", async () => {
		const snapshot = info();
		const baseModel = snapshot.models[0];
		if (!baseModel) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [
				{
					...baseModel,
					capabilities: ["completion"],
					model: "first:latest",
					name: "first:latest",
				},
				{
					...baseModel,
					capabilities: ["completion"],
					model: "second:latest",
					name: "second:latest",
				},
			],
		});
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const buttons = await screen.findAllByRole("button", {
			name: "Use with OpenCode",
		});
		const blockerIds = buttons.map((button) =>
			button.getAttribute("aria-describedby"),
		);

		expect(blockerIds.every(Boolean)).toBe(true);
		expect(new Set(blockerIds).size).toBe(2);
	});

	it("uses unique delete blockers for selected tags sharing one digest", async () => {
		const snapshot = info();
		const baseModel = snapshot.models[0];
		if (!baseModel) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [
				{ ...baseModel, model: "first:latest", name: "first:latest" },
				{ ...baseModel, model: "second:latest", name: "second:latest" },
			],
		});
		renderSection({
			ollama: {
				models: ["first:latest", "second:latest"],
				keep_warm: "5m",
			},
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const deleteButtons = await screen.findAllByRole("button", {
			name: "Delete",
		});
		const blockerIds = deleteButtons.map((button) =>
			button.getAttribute("aria-describedby"),
		);

		expect(blockerIds.every(Boolean)).toBe(true);
		expect(new Set(blockerIds).size).toBe(2);
	});

	it("connects a prepared model through top-level Ollama config and OpenCode visibility", async () => {
		fns.get.mockResolvedValue(info({ loadedModels: [loadedModel()] }));
		const onChange = vi.fn();
		const openCode: AcpAgentConfig = {
			id: "opencode",
			model_filter: { mode: "only", models: ["opencode/free-model"] },
		};
		renderSection({ openCode, onChange });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Use with OpenCode" }),
		);

		expect(onChange).toHaveBeenCalledWith(
			{ models: ["qwen3-coder:30b"], keep_warm: "5m" },
			{
				model_filter: {
					mode: "only",
					models: ["hlid-ollama/qwen3-coder:30b", "opencode/free-model"],
				},
			},
		);
	});

	it("configures how long OpenCode keeps used Ollama models warm", async () => {
		fns.get.mockResolvedValue(info());
		const onChange = vi.fn();
		renderSection({
			openCode: { id: "opencode" },
			ollama: { models: ["qwen3-coder:30b"], keep_warm: "5m" },
			onChange,
		});

		fireEvent.click(screen.getByRole("radio", { name: /30 minutes/i }));

		expect(onChange).toHaveBeenCalledWith({
			models: ["qwen3-coder:30b"],
			keep_warm: "30m",
		});
	});

	it("disconnects the last only-filter model and clears local defaults", async () => {
		fns.get.mockResolvedValue(info({ loadedModels: [loadedModel()] }));
		const onChange = vi.fn();
		const openCode: AcpAgentConfig = {
			id: "opencode",
			model: "hlid-ollama/qwen3-coder:30b",
			model_filter: {
				mode: "only",
				models: ["hlid-ollama/qwen3-coder:30b"],
			},
			recap_model: "hlid-ollama/qwen3-coder:30b",
		};
		renderSection({
			openCode,
			ollama: { models: ["qwen3-coder:30b"], keep_warm: "5m" },
			onChange,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const remove = await screen.findByRole("button", {
			name: "Remove from OpenCode",
		});
		fireEvent.click(remove);

		expect(onChange).toHaveBeenCalledWith(undefined, {
			model: undefined,
			model_filter: undefined,
			recap_model: undefined,
		});
	});

	it("keeps an incompatible model manageable while explaining its OpenCode blocker", async () => {
		const snapshot = info();
		const model = snapshot.models[0];
		if (!model) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [{ ...model, capabilities: ["completion"] }],
		});
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		expect(
			await screen.findByText(/does not advertise tool calling/i),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Use with OpenCode",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		expect(
			screen.queryByRole("button", { name: "Prepare for OpenCode" }),
		).toBeNull();
	});

	it("distinguishes unknown compatibility from confirmed missing tool support", async () => {
		const snapshot = info();
		const model = snapshot.models[0];
		if (!model) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [
				{
					...model,
					capabilities: [],
					compatibilityInspection: {
						status: "unknown",
						reason: "inspection-failed",
					},
					details: { ...model.details, contextLength: null },
				},
			],
		});
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);

		expect(
			await screen.findByText(/Hlid could not verify compatibility/i),
		).toBeTruthy();
		expect(screen.queryByText(/does not advertise tool calling/i)).toBeNull();
		expect(
			(
				screen.getByRole("button", {
					name: "Use with OpenCode",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Prepare for OpenCode" }),
		).toBeNull();
	});

	it("offers optional preparation without blocking connection", async () => {
		fns.get.mockResolvedValue(info());
		fns.load.mockResolvedValue({ ok: true });
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const prepare = await screen.findByRole("button", {
			name: "Prepare for OpenCode",
		});
		expect(prepare.className).toContain("min-h-11");
		expect(
			(
				screen.getByRole("button", {
					name: "Use with OpenCode",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);

		fireEvent.click(prepare);
		await waitFor(() =>
			expect(fns.load).toHaveBeenCalledWith({ data: "qwen3-coder:30b" }),
		);
	});

	it("does not treat a stale loaded digest as prepared", async () => {
		fns.get.mockResolvedValue(
			info({
				loadedModels: [loadedModel()],
				preparedModels: [
					{ ...loadedModel(), digest: "b".repeat(64), contextLength: 65_536 },
				],
			}),
		);
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);

		expect(
			await screen.findByRole("button", { name: "Prepare for OpenCode" }),
		).toBeTruthy();
		expect(screen.getAllByText(/not prepared/i).length).toBeGreaterThan(0);
	});

	it("allows multiple compatible models without requiring simultaneous loads", async () => {
		const snapshot = info();
		const baseModel = snapshot.models[0];
		if (!baseModel) throw new Error("missing Ollama model fixture");
		fns.get.mockResolvedValue({
			...snapshot,
			models: [
				baseModel,
				{
					...baseModel,
					digest: "b".repeat(64),
					model: "second:latest",
					name: "second:latest",
				},
			],
		});
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const connect = await screen.findAllByRole("button", {
			name: "Use with OpenCode",
		});

		expect(connect).toHaveLength(2);
		expect(
			connect.every((button) => !(button as HTMLButtonElement).disabled),
		).toBe(true);
	});

	it("keeps missing connected models removable while Ollama is unavailable", async () => {
		fns.get.mockResolvedValue(
			info({
				status: {
					available: false,
					checkedAt: Date.now(),
					reason: "unavailable",
					version: null,
				},
				models: [],
			}),
		);
		const onChange = vi.fn();
		renderSection({
			openCode: { id: "opencode" },
			ollama: { models: ["offline:latest"], keep_warm: "5m" },
			onChange,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Remove missing Ollama model offline:latest from OpenCode",
			}),
		);

		expect(onChange).toHaveBeenCalledWith(undefined, undefined);
	});

	it("keeps WSL firewall controls inside Use with OpenCode", async () => {
		fns.get.mockResolvedValue(
			info({
				wsl: [
					{
						ready: true,
						distro: "Ubuntu-24.04",
						mode: "nat",
						windowsHostAddress: "172.29.176.1",
						addressSource: "default_ipv4_gateway",
					},
				],
			}),
		);
		fns.firewall.mockResolvedValue({ exact: true });
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);
		const openCodeSection = (
			await screen.findByRole("heading", {
				name: "Use with OpenCode",
			})
		).closest("section");
		if (!openCodeSection) throw new Error("missing OpenCode section");
		const allow = within(openCodeSection).getByRole("button", {
			name: "Allow WSL OpenCode access",
		});
		expect(allow.className).toContain("min-h-11");
		fireEvent.click(allow);
		fireEvent.click(
			within(openCodeSection).getByRole("button", {
				name: "Request approval",
			}),
		);

		await waitFor(() => expect(fns.firewall).toHaveBeenCalledOnce());
	});

	it("keeps an installed Hlid WSL rule removable without a current NAT target", async () => {
		fns.get.mockResolvedValue(
			info({
				firewall: {
					supported: true,
					installed: true,
					exact: true,
					ruleName: "Hlid-Ollama-WSL",
					port: 11435,
				},
				wsl: [],
			}),
		);
		renderSection({ openCode: { id: "opencode" } });

		fireEvent.click(
			screen.getByRole("button", { name: "Check Windows Ollama" }),
		);

		expect(
			await screen.findByRole("button", {
				name: "Remove WSL OpenCode access",
			}),
		).toBeDefined();
	});
});
