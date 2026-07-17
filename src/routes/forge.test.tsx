// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => options,
	useRouter: () => ({ invalidate: vi.fn() }),
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({ handler: (handler: () => unknown) => handler }),
}));

vi.mock("#/components/forge/ForgeSettings", () => ({
	ForgeSettings: () => null,
}));
vi.mock("#/hooks/useSettingsForm", () => ({ useSettingsForm: vi.fn() }));
vi.mock("#/lib/serverFns/acp", () => ({ getAcpRegistryFn: vi.fn() }));
vi.mock("#/lib/serverFns/config", () => ({ getConfig: vi.fn() }));
vi.mock("#/lib/serverFns/providers", () => ({
	getAccountInfoFn: vi.fn(),
	getProvidersFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/voice", () => ({ getVoiceInfoFn: vi.fn() }));

import { getAcpRegistryFn } from "#/lib/serverFns/acp";
import { getConfig } from "#/lib/serverFns/config";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns/providers";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { Route } from "./forge";

type ForgeRoute = {
	loader: () => Promise<Record<string, unknown>>;
};
const route = Route as unknown as ForgeRoute;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getConfig).mockResolvedValue({ server: { port: 3000 } } as never);
	vi.mocked(getProvidersFn).mockResolvedValue([] as never);
	vi.mocked(getAccountInfoFn).mockResolvedValue(null as never);
	vi.mocked(getVoiceInfoFn).mockResolvedValue({
		status: { state: "ready", model: "base" },
		models: [],
	} as never);
	vi.mocked(getAcpRegistryFn).mockResolvedValue([] as never);
});

describe("forge route loader", () => {
	it("uses cached provider models for navigation", async () => {
		await route.loader();
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: {
				includeHostCapabilities: true,
				preferCachedModels: true,
			},
		});
	});

	it("does not let optional inventory hold Forge navigation pending", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(getProvidersFn).mockImplementation(() => new Promise(() => {}));
			vi.mocked(getAccountInfoFn).mockImplementation(
				() => new Promise(() => {}),
			);
			vi.mocked(getVoiceInfoFn).mockImplementation(() => new Promise(() => {}));
			vi.mocked(getAcpRegistryFn).mockImplementation(
				() => new Promise(() => {}),
			);
			const pending = route.loader();
			await vi.advanceTimersByTimeAsync(500);
			await expect(pending).resolves.toEqual(
				expect.objectContaining({
					providers: [],
					accountInfo: null,
					voiceInfo: expect.objectContaining({
						status: expect.objectContaining({ state: "unavailable" }),
					}),
					acpCatalog: [],
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
