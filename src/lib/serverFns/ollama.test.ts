import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbFetch } from "#/lib/dbClient";
import type { OllamaIntegrationInfo } from "#/server/ollamaIntegration";
import {
	cancelOllamaWindowsSetupDownload,
	inspectOllamaInfo,
	inspectOllamaWindowsSetupInfo,
	launchOllamaWindowsSetup,
	startOllamaWindowsSetupDownload,
} from "./ollama";

vi.mock("#/lib/dbClient", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/dbClient")>();
	return { ...actual, dbFetch: vi.fn() };
});

function unsupportedInfo(): OllamaIntegrationInfo {
	return {
		supported: false,
		host: "windows",
		status: {
			available: false,
			checkedAt: 123_000,
			reason: "unavailable",
			version: null,
		},
		setup: { phase: "idle" },
		models: [],
		loadedModels: [],
		preparedModels: [],
		selectedModels: [],
		pull: { state: "idle" },
		firewall: {
			supported: false,
			installed: false,
			exact: false,
			ruleName: "Hlid-Ollama-WSL",
			port: 11435,
		},
		wsl: [],
		relay: { port: 11435, listeners: [] },
	};
}

describe("Ollama status server function", () => {
	beforeEach(() => vi.resetAllMocks());

	it.each([
		{
			name: "a transport timeout",
			response: () =>
				vi
					.mocked(dbFetch)
					.mockRejectedValue(new DOMException("timed out", "TimeoutError")),
		},
		{
			name: "an HTTP failure",
			response: () =>
				vi
					.mocked(dbFetch)
					.mockResolvedValue(
						Response.json({ error: "unavailable" }, { status: 503 }),
					),
		},
		{
			name: "malformed JSON",
			response: () =>
				vi.mocked(dbFetch).mockResolvedValue(
					new Response("{not-json", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				),
		},
		{
			name: "a malformed status envelope",
			response: () =>
				vi
					.mocked(dbFetch)
					.mockResolvedValue(Response.json({ supported: false })),
		},
	])("surfaces $name as a retryable inspection error", async ({ response }) => {
		response();

		await expect(inspectOllamaInfo()).rejects.toThrow(
			"Could not inspect Windows Ollama. Hlid could not read the integration status. Try again.",
		);
	});

	it("preserves a genuine unsupported-host response", async () => {
		const payload = unsupportedInfo();
		vi.mocked(dbFetch).mockResolvedValue(Response.json(payload));

		await expect(inspectOllamaInfo()).resolves.toEqual(payload);
	});

	it("rejects a status envelope that omits Windows setup state", async () => {
		const { setup: _, ...payload } = unsupportedInfo();
		vi.mocked(dbFetch).mockResolvedValue(Response.json(payload));

		await expect(inspectOllamaInfo()).rejects.toThrow(
			"Could not inspect Windows Ollama",
		);
	});

	it("uses the lightweight setup route for setup polling", async () => {
		const payload = {
			status: unsupportedInfo().status,
			setup: { phase: "resolving", startedAt: 123_000 } as const,
		};
		vi.mocked(dbFetch).mockResolvedValue(Response.json(payload));

		await expect(inspectOllamaWindowsSetupInfo()).resolves.toEqual(payload);
		expect(dbFetch).toHaveBeenCalledWith("/ollama/setup");
	});

	it("accepts a retained installer after Windows verification infrastructure fails", async () => {
		const payload = {
			status: unsupportedInfo().status,
			setup: {
				phase: "verification_failed",
				startedAt: 123_000,
				completedAt: 124_000,
				version: "0.32.14",
				bytes: 1_564_916_544,
				reason: "Ollama installer signature verification failed",
			} as const,
		};
		vi.mocked(dbFetch).mockResolvedValue(Response.json(payload));

		await expect(inspectOllamaWindowsSetupInfo()).resolves.toEqual(payload);
	});

	it("rejects an incomplete retained-verification state", async () => {
		const payload = {
			status: unsupportedInfo().status,
			setup: {
				phase: "verification_failed",
				startedAt: 123_000,
				completedAt: 124_000,
				version: "0.32.14",
				bytes: 1_564_916_544,
			},
		};
		vi.mocked(dbFetch).mockResolvedValue(Response.json(payload));

		await expect(inspectOllamaWindowsSetupInfo()).rejects.toThrow(
			"Could not inspect Ollama Windows setup",
		);
	});

	it.each([
		{
			name: "starts the installer download",
			invoke: startOllamaWindowsSetupDownload,
			path: "/ollama/setup/download",
			method: "POST",
			state: { phase: "resolving", startedAt: 123_000 } as const,
		},
		{
			name: "cancels the installer download",
			invoke: cancelOllamaWindowsSetupDownload,
			path: "/ollama/setup/download",
			method: "DELETE",
			state: {
				phase: "canceled",
				startedAt: 123_000,
				completedAt: 124_000,
			} as const,
		},
		{
			name: "launches the verified installer",
			invoke: launchOllamaWindowsSetup,
			path: "/ollama/setup/launch",
			method: "POST",
			state: {
				phase: "launched",
				startedAt: 123_000,
				launchedAt: 124_000,
				version: "0.12.3",
				bytes: 2_048,
			} as const,
		},
	])("$name through the exact internal route", async ({
		invoke,
		path,
		method,
		state,
	}) => {
		vi.mocked(dbFetch).mockResolvedValue(Response.json(state));

		await expect(invoke()).resolves.toEqual(state);
		expect(dbFetch).toHaveBeenCalledWith(path, { method });
	});
});
