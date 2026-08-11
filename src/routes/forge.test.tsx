// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
	loaderData: null as Record<string, unknown> | null,
	search: {} as Record<string, unknown>,
	navigate: vi.fn(),
	forgeSettings: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => routeState.loaderData,
		useSearch: () => routeState.search,
	}),
	useNavigate: () => routeState.navigate,
	useRouter: () => ({ invalidate: vi.fn() }),
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({ handler: (handler: () => unknown) => handler }),
}));

vi.mock("#/components/forge/ForgeSettings", () => ({
	ForgeSettings: (props: unknown) => {
		routeState.forgeSettings(props);
		return null;
	},
}));
vi.mock("#/hooks/useSettingsForm", () => ({ useSettingsForm: vi.fn() }));
vi.mock("#/lib/serverFns/acp", () => ({
	discoverAcpModelsFn: vi.fn(),
	getAcpRegistryFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/cliproxy", () => ({
	getCliProxyInfoFn: vi.fn().mockResolvedValue({
		state: "ready",
		managed: false,
		authenticated: false,
		oauth: "idle",
		accounts: {},
	}),
	refreshCliProxyInfoFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/config");
vi.mock("#/lib/serverFns/providers", () => ({
	getAccountInfoFn: vi.fn(),
	getProvidersFn: vi.fn(),
}));
vi.mock("#/lib/serverFns/voice", () => ({ getVoiceInfoFn: vi.fn() }));

import { discoverAcpModelsFn, getAcpRegistryFn } from "#/lib/serverFns/acp";
import { getConfig } from "#/lib/serverFns/config";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns/providers";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { providerOptionRefreshError, Route } from "./forge";

type ForgeRoute = {
	loader: () => Promise<Record<string, unknown>>;
	loaderDeps: (input: { search: Record<string, unknown> }) => object;
	staleTime: number;
	gcTime: number;
	component: ComponentType;
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
	vi.mocked(discoverAcpModelsFn).mockResolvedValue([] as never);
	routeState.loaderData = null;
	routeState.search = {};
});

describe("forge route loader", () => {
	it("keeps URL-only navigation out of inventory loading and retains the loader seed", () => {
		expect(
			route.loaderDeps({
				search: {
					category: "integrations",
					section: "opencode-acp",
					view: "acp",
				},
			}),
		).toEqual({});
		expect(route.staleTime).toBe(Number.POSITIVE_INFINITY);
		expect(route.gcTime).toBe(Number.POSITIVE_INFINITY);
	});

	it("uses cached provider models for navigation", async () => {
		await route.loader();
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: {
				includeHostCapabilities: true,
				includeProviderCapabilities: true,
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

describe("forge inventory refresh", () => {
	it("hydrates URL-backed Forge navigation and serializes destination changes", () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		routeState.search = {
			category: "developer",
			setting: "pricing",
		};

		const Component = route.component;
		render(<Component />);
		expect(routeState.forgeSettings.mock.lastCall?.[0].navigation).toEqual({
			category: "developer",
			section: "pricing",
			setting: "pricing",
			view: "pricing",
		});

		const onNavigationChange = routeState.forgeSettings.mock.lastCall?.[0]
			.onNavigationChange as (navigation: Record<string, unknown>) => void;
		onNavigationChange({
			category: "experience",
			section: "voice-input",
			setting: "recording-hotkey",
		});

		expect(routeState.navigate).toHaveBeenCalledWith({
			search: {
				category: "experience",
				setting: "recording-hotkey",
			},
			resetScroll: false,
		});

		onNavigationChange({
			category: "overview",
			section: "updates",
			setting: "check-for-updates",
		});
		expect(routeState.navigate).toHaveBeenLastCalledWith({
			search: {
				category: "overview",
				setting: "check-for-updates",
			},
			resetScroll: false,
		});
	});

	it("round-trips ACP landing and editor history states without conflating them", () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		routeState.search = {
			category: "integrations",
			section: "opencode-acp",
		};

		const Component = route.component;
		const view = render(<Component />);
		expect(routeState.forgeSettings.mock.lastCall?.[0].navigation).toEqual({
			category: "integrations",
			section: "opencode-acp",
		});

		const onNavigationChange = routeState.forgeSettings.mock.lastCall?.[0]
			.onNavigationChange as (
			navigation: Record<string, unknown>,
			options?: { replace?: boolean },
		) => void;
		onNavigationChange({
			category: "integrations",
			section: "opencode-acp",
			view: "acp",
		});
		expect(routeState.navigate).toHaveBeenLastCalledWith({
			search: {
				category: "integrations",
				section: "opencode-acp",
				view: "acp",
			},
			resetScroll: false,
		});

		onNavigationChange(
			{
				category: "integrations",
				section: "opencode-acp",
			},
			{ replace: true },
		);
		expect(routeState.navigate).toHaveBeenLastCalledWith({
			search: {
				category: "integrations",
				section: "opencode-acp",
			},
			resetScroll: false,
			replace: true,
		});

		// Rehydrating the replaced URL models the inline Back transition. A later
		// browser Back can now leave this landing instead of reopening the editor.
		routeState.search = {
			category: "integrations",
			section: "opencode-acp",
		};
		view.rerender(<Component />);
		expect(routeState.forgeSettings.mock.lastCall?.[0].navigation).toEqual({
			category: "integrations",
			section: "opencode-acp",
		});
	});

	it("wires on-demand ACP model discovery without adding it to navigation", async () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		vi.mocked(discoverAcpModelsFn).mockResolvedValue([
			{ value: "opencode/allowed", label: "Allowed" },
		] as never);

		const Component = route.component;
		render(<Component />);
		const discover = routeState.forgeSettings.mock.lastCall?.[0]
			.onDiscoverAcpModels as (id: string) => Promise<unknown>;

		await expect(discover("opencode")).resolves.toEqual([
			{ value: "opencode/allowed", label: "Allowed" },
		]);
		expect(discoverAcpModelsFn).toHaveBeenCalledWith({
			data: { id: "opencode" },
		});
	});

	it("does not claim modes refreshed when ACP capability inspection fell back", () => {
		const error = providerOptionRefreshError("acp:opencode", [
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "agent/model", label: "Agent Model" }],
				modelCatalogRefresh: { status: "current", source: "live" },
				capabilitySnapshot: {
					status: "partial",
					issues: ["Provider capability discovery failed"],
				},
			} as never,
		]);

		expect(error?.message).toBe(
			"OpenCode option refresh was incomplete; models were refreshed, but live mode capabilities were not: Provider capability discovery failed",
		);
	});

	it("waits for an explicit ACP option refresh beyond the recovery-loader budget", async () => {
		vi.useFakeTimers();
		try {
			routeState.loaderData = {
				server: { port: 3000 },
				cwd: "C:\\workspace",
				providers: [],
				accountInfo: null,
				voiceInfo: {
					status: { state: "ready", model: "base" },
					models: [],
				},
				cliProxyInfo: {
					state: "ready",
					managed: false,
					authenticated: false,
					oauth: "idle",
					accounts: {},
				},
				acpCatalog: [],
				inventoryStatus: "ready",
			};
			vi.mocked(getProvidersFn).mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve([
									{
										id: "acp:opencode",
										label: "OpenCode",
										available: true,
										models: [{ value: "agent/model", label: "Agent Model" }],
										modelCatalogRefresh: {
											status: "current",
											source: "live",
										},
									},
								] as never),
							12_000,
						),
					),
			);
			const Component = route.component;
			render(<Component />);
			const refresh = routeState.forgeSettings.mock.lastCall?.[0]
				.onRefreshProviderOptions as (providerId: string) => Promise<void>;

			await act(async () => {
				const pending = refresh("acp:opencode");
				await vi.advanceTimersByTimeAsync(12_000);
				await pending;
			});

			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
					.models[0].value,
			).toBe("agent/model");
			expect(getProvidersFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					refresh: true,
					refreshProviderId: "acp:opencode",
				}),
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps cached options visible while rejecting a stale explicit refresh", async () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		vi.mocked(getProvidersFn).mockResolvedValue([
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "cached", label: "Cached" }],
				modelCatalogRefresh: {
					status: "stale",
					source: "memory",
					reason: "Live model discovery did not return current options",
				},
			},
		] as never);
		const Component = route.component;
		render(<Component />);
		const refresh = routeState.forgeSettings.mock.lastCall?.[0]
			.onRefreshProviderOptions as (providerId: string) => Promise<void>;

		await expect(refresh("acp:opencode")).rejects.toThrow(
			"OpenCode option refresh failed; showing cached options",
		);
		await waitFor(() =>
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].models,
			).toEqual([{ value: "cached", label: "Cached" }]),
		);
	});

	it("recovers missing Computer Use readiness once without refreshing provider options", async () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [{ value: "cached", label: "Cached" }],
				},
			],
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		vi.mocked(getProvidersFn).mockResolvedValue([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [{ value: "cached", label: "Cached" }],
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
		] as never);

		const Component = route.component;
		render(<Component />);

		await waitFor(() =>
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
					.hostCapabilities.windowsComputerUse.available,
			).toBe(true),
		);
		expect(getProvidersFn).toHaveBeenCalledTimes(1);
		expect(getProvidersFn).toHaveBeenCalledWith({
			data: {
				includeHostCapabilities: true,
				waitForHostCapabilities: true,
				preferCachedModels: true,
			},
		});
	});

	it("runs a fresh Computer Use recovery for an explicitly replaced loader seed", async () => {
		const base = {
			server: { port: 3000 },
			cwd: "/workspace",
			accountInfo: null,
			voiceInfo: { status: { state: "ready", model: "base" }, models: [] },
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		const cachedProviders = [
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [{ value: "cached", label: "Cached" }],
			},
		];
		routeState.loaderData = { ...base, providers: cachedProviders };
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce([
				{
					...cachedProviders[0],
					hostCapabilities: {
						windowsComputerUse: {
							label: "Windows Computer Use",
							available: false,
							reason: "Hlid is not running on Windows",
						},
					},
				},
			] as never)
			.mockResolvedValueOnce([
				{
					...cachedProviders[0],
					hostCapabilities: {
						windowsComputerUse: {
							label: "Windows Computer Use",
							available: true,
						},
					},
				},
			] as never);

		const Component = route.component;
		const view = render(<Component />);

		await waitFor(() =>
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
					.hostCapabilities.windowsComputerUse.reason,
			).toBe("Hlid is not running on Windows"),
		);

		routeState.loaderData = {
			...base,
			providers: cachedProviders.map((provider) => ({ ...provider })),
		};
		view.rerender(<Component />);

		await waitFor(() =>
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
					.hostCapabilities.windowsComputerUse.available,
			).toBe(true),
		);
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("reuses recovered provisional inventory after leaving and returning", async () => {
		const loaderSeed = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
			},
			cliProxyInfo: {
				state: "error",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "unavailable",
		};
		routeState.loaderData = loaderSeed;
		vi.mocked(getProvidersFn).mockResolvedValue([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [{ value: "cached", label: "Cached" }],
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
		] as never);
		vi.mocked(getVoiceInfoFn).mockResolvedValue({
			status: { state: "ready", model: "base" },
			models: [],
		} as never);

		const Component = route.component;
		const firstVisit = render(<Component />);
		await waitFor(() => {
			expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
				"ready",
			);
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].id,
			).toBe("codex");
		});
		expect(getProvidersFn).toHaveBeenCalledTimes(1);
		expect(getAcpRegistryFn).toHaveBeenCalledTimes(1);

		firstVisit.unmount();
		routeState.forgeSettings.mockClear();
		render(<Component />);

		expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
			"ready",
		);
		expect(
			routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].id,
		).toBe("codex");
		await act(async () => {});
		expect(getProvidersFn).toHaveBeenCalledTimes(1);
		expect(getAcpRegistryFn).toHaveBeenCalledTimes(1);
	});

	it("rejoins an in-flight provisional recovery after returning without rediscovery", async () => {
		const loaderSeed = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
			},
			cliProxyInfo: {
				state: "error",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "unavailable",
		};
		routeState.loaderData = loaderSeed;
		let resolveProviders: ((providers: unknown[]) => void) | undefined;
		vi.mocked(getProvidersFn).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveProviders = resolve as (providers: unknown[]) => void;
				}),
		);

		const Component = route.component;
		const firstVisit = render(<Component />);
		await waitFor(() =>
			expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
				"loading",
			),
		);
		expect(getProvidersFn).toHaveBeenCalledTimes(1);

		firstVisit.unmount();
		routeState.forgeSettings.mockClear();
		render(<Component />);
		expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
			"loading",
		);
		expect(getProvidersFn).toHaveBeenCalledTimes(1);

		resolveProviders?.([
			{
				id: "codex",
				label: "Codex",
				available: true,
				models: [],
				hostCapabilities: {
					windowsComputerUse: {
						label: "Windows Computer Use",
						available: true,
					},
				},
			},
		]);
		await waitFor(() => {
			expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
				"ready",
			);
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].id,
			).toBe("codex");
		});
		expect(getProvidersFn).toHaveBeenCalledTimes(1);
	});

	it("does not let older automatic recovery overwrite explicit provider options", async () => {
		routeState.loaderData = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			providers: [],
			accountInfo: null,
			voiceInfo: {
				status: { state: "unavailable", model: "" },
				models: [],
			},
			cliProxyInfo: {
				state: "error",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "unavailable",
		};
		let resolveAutomaticProviders: ((providers: unknown[]) => void) | undefined;
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveAutomaticProviders = resolve as (
							providers: unknown[],
						) => void;
					}),
			)
			.mockResolvedValueOnce([
				{
					id: "acp:opencode",
					label: "OpenCode",
					available: true,
					models: [{ value: "fresh", label: "Fresh" }],
					modelCatalogRefresh: { status: "current", source: "live" },
				},
			] as never);

		const Component = route.component;
		const firstVisit = render(<Component />);
		await waitFor(() =>
			expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
				"loading",
			),
		);
		firstVisit.unmount();
		routeState.forgeSettings.mockClear();
		render(<Component />);
		expect(getProvidersFn).toHaveBeenCalledTimes(1);
		const refresh = routeState.forgeSettings.mock.lastCall?.[0]
			.onRefreshProviderOptions as (providerId: string) => Promise<void>;
		await act(() => refresh("acp:opencode"));
		expect(
			routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].models,
		).toEqual([{ value: "fresh", label: "Fresh" }]);

		resolveAutomaticProviders?.([
			{
				id: "acp:opencode",
				label: "OpenCode",
				available: true,
				models: [{ value: "old", label: "Old" }],
			},
		]);
		await waitFor(() =>
			expect(routeState.forgeSettings.mock.lastCall?.[0].inventoryStatus).toBe(
				"ready",
			),
		);
		expect(
			routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0].models,
		).toEqual([{ value: "fresh", label: "Fresh" }]);
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("replaces a provisional capability after route revalidation", async () => {
		const base = {
			server: { port: 3000 },
			cwd: "C:\\workspace",
			accountInfo: null,
			voiceInfo: {
				status: { state: "ready", model: "base" },
				models: [],
			},
			cliProxyInfo: {
				state: "ready",
				managed: false,
				authenticated: false,
				oauth: "idle",
				accounts: {},
			},
			acpCatalog: [],
			inventoryStatus: "ready",
		};
		routeState.loaderData = {
			...base,
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					hostCapabilities: {
						windowsComputerUse: {
							label: "Windows Computer Use",
							available: false,
							reason: "Capability status is refreshing",
						},
					},
				},
			],
		};
		const Component = route.component;
		const view = render(<Component />);

		expect(
			routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
				.hostCapabilities.windowsComputerUse.reason,
		).toBe("Capability status is refreshing");

		routeState.loaderData = {
			...base,
			providers: [
				{
					id: "codex",
					label: "Codex",
					available: true,
					models: [],
					hostCapabilities: {
						windowsComputerUse: {
							label: "Windows Computer Use",
							available: true,
						},
					},
				},
			],
		};
		view.rerender(<Component />);

		await waitFor(() =>
			expect(
				routeState.forgeSettings.mock.lastCall?.[0].initial.providers[0]
					.hostCapabilities.windowsComputerUse,
			).toEqual({
				label: "Windows Computer Use",
				available: true,
			}),
		);
	});
});
