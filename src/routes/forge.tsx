import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ForgeSettings } from "#/components/forge/ForgeSettings";
import { type SettingsInitial, useSettingsForm } from "#/hooks/useSettingsForm";
import {
	type ForgeNavigationOptions,
	type ForgeNavigationState,
	forgeSearchFromNavigation,
	normalizeForgeNavigation,
	parseForgeSearch,
} from "#/lib/forgeNavigation";
import { optionalLoaderValue } from "#/lib/loaderFallback";
import type { ProviderInfo } from "#/lib/providerTypes";
import { discoverAcpModelsFn, getAcpRegistryFn } from "#/lib/serverFns/acp";
import {
	getCliProxyInfoFn,
	refreshCliProxyInfoFn,
} from "#/lib/serverFns/cliproxy";
import { getConfig } from "#/lib/serverFns/config";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns/providers";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());
const FORGE_OPTIONAL_LOADER_WAIT_MS = 500;
const FORGE_INVENTORY_RECOVERY_WAIT_MS = 8_000;
type ForgeInventoryStatus = "loading" | "ready" | "unavailable";
type ForgeInventory = Pick<
	SettingsInitial,
	"providers" | "accountInfo" | "voiceInfo" | "cliProxyInfo" | "acpCatalog"
>;
type ForgeInventorySeed = ForgeInventory & {
	inventoryStatus: Exclude<ForgeInventoryStatus, "loading">;
};
type RetainedForgeInventory = {
	inventory: ForgeInventory;
	inventoryStatus: ForgeInventoryStatus;
	recoveredHostCapabilities?: ProviderInfo["hostCapabilities"];
	recoveryAttempted: boolean;
	hostCapabilityRecoveryAttempted: boolean;
	providerRefreshGeneration: number;
	providerInventoryRevision: number;
	listeners: Set<(snapshot: RetainedForgeInventory) => void>;
};

// Route data is retained by TanStack Router between visits. Key the recovered
// client inventory to that exact loader seed so returning to Forge can reuse it,
// while an explicit router invalidation receives a new seed and replaces it.
const retainedForgeInventory =
	typeof window === "undefined"
		? undefined
		: new WeakMap<object, RetainedForgeInventory>();

function forgeInventoryFromSeed(seed: ForgeInventorySeed): ForgeInventory {
	return {
		providers: seed.providers,
		accountInfo: seed.accountInfo,
		voiceInfo: seed.voiceInfo,
		cliProxyInfo: seed.cliProxyInfo,
		acpCatalog: seed.acpCatalog,
	};
}

function retainedInventoryForSeed(
	seed: ForgeInventorySeed,
): RetainedForgeInventory {
	const cached = retainedForgeInventory?.get(seed);
	if (cached) return cached;
	const initial: RetainedForgeInventory = {
		inventory: forgeInventoryFromSeed(seed),
		inventoryStatus: seed.inventoryStatus,
		recoveryAttempted: false,
		hostCapabilityRecoveryAttempted: false,
		providerRefreshGeneration: 0,
		providerInventoryRevision: 0,
		listeners: new Set(),
	};
	retainedForgeInventory?.set(seed, initial);
	return initial;
}
const UNAVAILABLE_VOICE_INFO = {
	status: {
		state: "unavailable" as const,
		model: "",
		error: "voice service unavailable",
	},
	models: [],
};
const UNAVAILABLE_CLIPROXY_INFO = {
	state: "error" as const,
	managed: false,
	authenticated: false,
	oauth: "idle" as const,
	accounts: {
		codex: "idle" as const,
		claude: "idle" as const,
		antigravity: "idle" as const,
		kimi: "idle" as const,
		xai: "idle" as const,
	},
	error: "CLIProxy integration unavailable",
};

export function providerOptionRefreshError(
	providerId: string,
	providers: ProviderInfo[],
): Error | null {
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (!provider) {
		return new Error(
			`Provider ${providerId} disappeared during option refresh`,
		);
	}
	const refresh = provider.modelCatalogRefresh;
	if (refresh?.status === "current") {
		const capabilities = provider.capabilitySnapshot;
		if (
			provider.id.startsWith("acp:") &&
			capabilities &&
			capabilities.status !== "current"
		) {
			const capabilityReason = capabilities.issues?.[0];
			return new Error(
				`${provider.label} option refresh was incomplete; models were refreshed, but live mode capabilities were not${
					capabilityReason ? `: ${capabilityReason}` : ""
				}`,
			);
		}
		return null;
	}
	const reason = refresh?.reason ?? provider.unavailableReason;
	const detail = reason ? `: ${reason}` : "";
	if (refresh?.status === "stale") {
		return new Error(
			`${provider.label} option refresh failed; showing cached options${detail}`,
		);
	}
	if (refresh?.status === "unavailable" || provider.available === false) {
		return new Error(
			`${provider.label} option refresh failed; no current options are available${detail}`,
		);
	}
	// Older Hlid servers do not return refresh metadata. Preserve compatibility
	// and treat their otherwise valid provider response as successful.
	return null;
}

export const Route = createFileRoute("/forge")({
	validateSearch: parseForgeSearch,
	// Forge search params only address client-rendered settings. Keep them out of
	// the route match identity, and retain the expensive inventory across visits
	// until an explicit router invalidation marks this loader data stale.
	loaderDeps: () => ({}),
	staleTime: Number.POSITIVE_INFINITY,
	gcTime: Number.POSITIVE_INFINITY,
	loader: async () => {
		const [
			config,
			cwd,
			providers,
			accountInfo,
			voiceInfo,
			cliProxyInfo,
			acpCatalog,
		] = await Promise.all([
			getConfig(),
			getCwdFn(),
			optionalLoaderValue(
				getProvidersFn({
					data: {
						includeHostCapabilities: true,
						includeProviderCapabilities: true,
						preferCachedModels: true,
					},
				}),
				[],
				FORGE_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getAccountInfoFn(),
				null,
				FORGE_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getVoiceInfoFn(),
				UNAVAILABLE_VOICE_INFO,
				FORGE_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getCliProxyInfoFn(),
				UNAVAILABLE_CLIPROXY_INFO,
				FORGE_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getAcpRegistryFn(),
				[],
				FORGE_OPTIONAL_LOADER_WAIT_MS,
			),
		]);
		const inventoryStatus = [
			providers,
			accountInfo,
			voiceInfo,
			cliProxyInfo,
			acpCatalog,
		].some((item) => item.status === "unavailable")
			? ("unavailable" as const)
			: ("ready" as const);
		return {
			...config,
			cwd,
			providers: providers.value,
			accountInfo: accountInfo.value,
			voiceInfo: voiceInfo.value,
			cliProxyInfo: cliProxyInfo.value,
			acpCatalog: acpCatalog.value,
			inventoryStatus,
		};
	},
	component: SettingsPage,
});

function SettingsPage() {
	const loaded = Route.useLoaderData();
	const loaderSeed = loaded as ForgeInventorySeed;
	const routeSearch = Route.useSearch();
	const navigate = useNavigate({ from: "/forge" });
	const router = useRouter();
	const navigation = normalizeForgeNavigation(routeSearch);
	const initialRetained = useRef<RetainedForgeInventory | null>(null);
	if (!initialRetained.current) {
		initialRetained.current = retainedInventoryForSeed(loaderSeed);
	}
	const [inventory, setInventory] = useState(
		() =>
			initialRetained.current?.inventory ?? forgeInventoryFromSeed(loaderSeed),
	);
	const [inventoryStatus, setInventoryStatus] = useState<ForgeInventoryStatus>(
		() =>
			initialRetained.current?.inventoryStatus ?? loaderSeed.inventoryStatus,
	);
	const [recoveredHostCapabilities, setRecoveredHostCapabilities] = useState<
		ProviderInfo["hostCapabilities"]
	>(() => initialRetained.current?.recoveredHostCapabilities);
	const loaderSeedRef = useRef(loaderSeed);
	const inventoryRef = useRef(inventory);
	const inventoryStatusRef = useRef(inventoryStatus);
	const recoveredHostCapabilitiesRef = useRef(recoveredHostCapabilities);
	const recoveryAttempted = useRef(
		initialRetained.current?.recoveryAttempted ?? false,
	);
	const hostCapabilityRecoveryAttempted = useRef(
		initialRetained.current?.hostCapabilityRecoveryAttempted ?? false,
	);
	const mounted = useRef(true);

	const persistRetainedInventory = useCallback(() => {
		const seed = loaderSeedRef.current;
		const current = retainedForgeInventory?.get(seed);
		const next: RetainedForgeInventory = {
			inventory: inventoryRef.current,
			inventoryStatus: inventoryStatusRef.current,
			recoveredHostCapabilities: recoveredHostCapabilitiesRef.current,
			recoveryAttempted: recoveryAttempted.current,
			hostCapabilityRecoveryAttempted: hostCapabilityRecoveryAttempted.current,
			providerRefreshGeneration: current?.providerRefreshGeneration ?? 0,
			providerInventoryRevision: current?.providerInventoryRevision ?? 0,
			listeners: current?.listeners ?? new Set(),
		};
		retainedForgeInventory?.set(seed, next);
		for (const listener of next.listeners) listener(next);
	}, []);

	const commitInventory = useCallback(
		(
			nextInventory: ForgeInventory,
			nextStatus = inventoryStatusRef.current,
			nextRecoveredHostCapabilities = recoveredHostCapabilitiesRef.current,
		) => {
			inventoryRef.current = nextInventory;
			inventoryStatusRef.current = nextStatus;
			recoveredHostCapabilitiesRef.current = nextRecoveredHostCapabilities;
			persistRetainedInventory();
			if (!mounted.current) return;
			setInventory(nextInventory);
			setInventoryStatus(nextStatus);
			setRecoveredHostCapabilities(nextRecoveredHostCapabilities);
		},
		[persistRetainedInventory],
	);

	const refreshInventory = useCallback(
		async (force = false) => {
			const requestSeed = loaderSeedRef.current;
			const providerState = retainedInventoryForSeed(requestSeed);
			const providerRevision = providerState.providerInventoryRevision;
			const providerGeneration = force
				? ++providerState.providerRefreshGeneration
				: providerState.providerRefreshGeneration;
			if (force) {
				hostCapabilityRecoveryAttempted.current = false;
			}
			commitInventory(
				inventoryRef.current,
				"loading",
				force ? undefined : recoveredHostCapabilitiesRef.current,
			);
			const [providers, accountInfo, voiceInfo, cliProxyInfo, acpCatalog] =
				await Promise.all([
					optionalLoaderValue(
						getProvidersFn({
							data: {
								refresh: force,
								includeHostCapabilities: true,
								includeProviderCapabilities: true,
								preferCachedModels: !force,
							},
						}),
						[],
						FORGE_INVENTORY_RECOVERY_WAIT_MS,
					),
					optionalLoaderValue(
						getAccountInfoFn(),
						null,
						FORGE_INVENTORY_RECOVERY_WAIT_MS,
					),
					optionalLoaderValue(
						getVoiceInfoFn(force ? { data: { refresh: true } } : undefined),
						UNAVAILABLE_VOICE_INFO,
						FORGE_INVENTORY_RECOVERY_WAIT_MS,
					),
					optionalLoaderValue(
						force ? refreshCliProxyInfoFn() : getCliProxyInfoFn(),
						UNAVAILABLE_CLIPROXY_INFO,
						FORGE_INVENTORY_RECOVERY_WAIT_MS,
					),
					optionalLoaderValue(
						getAcpRegistryFn(force ? { data: { refresh: true } } : undefined),
						[],
						FORGE_INVENTORY_RECOVERY_WAIT_MS,
					),
				]);
			if (loaderSeedRef.current !== requestSeed) return;
			const currentProviderState = retainedInventoryForSeed(requestSeed);
			// Another Forge instance can finish an explicit provider refresh while
			// this recovery is in flight. Merge against the retained shared snapshot,
			// not this instance's potentially stale ref after an unmount/remount.
			const current = currentProviderState.inventory;
			const providerResultIsCurrent = force
				? currentProviderState.providerRefreshGeneration === providerGeneration
				: currentProviderState.providerInventoryRevision === providerRevision;
			const nextInventory = {
				providers:
					providers.status === "ready" && providerResultIsCurrent
						? providers.value
						: current.providers,
				accountInfo:
					accountInfo.status === "ready"
						? accountInfo.value
						: current.accountInfo,
				voiceInfo:
					voiceInfo.status === "ready" ? voiceInfo.value : current.voiceInfo,
				cliProxyInfo:
					cliProxyInfo.status === "ready"
						? cliProxyInfo.value
						: current.cliProxyInfo,
				acpCatalog:
					acpCatalog.status === "ready" ? acpCatalog.value : current.acpCatalog,
			};
			if (force && providers.status === "ready" && providerResultIsCurrent) {
				currentProviderState.providerInventoryRevision += 1;
			}
			commitInventory(
				nextInventory,
				[providers, accountInfo, voiceInfo, cliProxyInfo, acpCatalog].every(
					(item) => item.status === "ready",
				)
					? "ready"
					: "unavailable",
			);
		},
		[commitInventory],
	);
	const commitAcpCatalog = useCallback(
		(acpCatalog: ForgeInventory["acpCatalog"]) => {
			commitInventory({ ...inventoryRef.current, acpCatalog });
		},
		[commitInventory],
	);
	const refreshProviderOptions = useCallback(
		async (providerId: string) => {
			const requestSeed = loaderSeedRef.current;
			const providerState = retainedInventoryForSeed(requestSeed);
			const providerGeneration = ++providerState.providerRefreshGeneration;
			const providers = await getProvidersFn({
				data: {
					refresh: true,
					refreshProviderId: providerId,
					includeHostCapabilities: true,
					includeProviderCapabilities: true,
					preferCachedModels: false,
				},
			});
			if (
				loaderSeedRef.current === requestSeed &&
				retainedInventoryForSeed(requestSeed).providerRefreshGeneration ===
					providerGeneration
			) {
				const current = retainedInventoryForSeed(requestSeed);
				current.providerInventoryRevision += 1;
				commitInventory(
					{ ...current.inventory, providers },
					current.inventoryStatus,
					current.recoveredHostCapabilities,
				);
			}
			const error = providerOptionRefreshError(providerId, providers);
			if (error) throw error;
		},
		[commitInventory],
	);
	const discoverAcpModels = useCallback(
		(id: string) => discoverAcpModelsFn({ data: { id } }),
		[],
	);
	const navigateForge = useCallback(
		(next: ForgeNavigationState, options?: ForgeNavigationOptions) => {
			void navigate({
				search: forgeSearchFromNavigation(next),
				resetScroll: false,
				...(options?.replace ? { replace: true } : {}),
			});
		},
		[navigate],
	);
	const applyRetainedSnapshot = useCallback((next: RetainedForgeInventory) => {
		inventoryRef.current = next.inventory;
		inventoryStatusRef.current = next.inventoryStatus;
		recoveredHostCapabilitiesRef.current = next.recoveredHostCapabilities;
		recoveryAttempted.current = next.recoveryAttempted;
		hostCapabilityRecoveryAttempted.current =
			next.hostCapabilityRecoveryAttempted;
		setInventory(next.inventory);
		setInventoryStatus(next.inventoryStatus);
		setRecoveredHostCapabilities(next.recoveredHostCapabilities);
	}, []);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		const subscribedSeed = loaderSeed;
		const retained = retainedInventoryForSeed(subscribedSeed);
		const updateFromRetained = (next: RetainedForgeInventory) => {
			if (!mounted.current || loaderSeedRef.current !== subscribedSeed) return;
			applyRetainedSnapshot(next);
		};
		retained.listeners.add(updateFromRetained);
		return () => {
			retained.listeners.delete(updateFromRetained);
		};
	}, [applyRetainedSnapshot, loaderSeed]);

	useEffect(() => {
		if (loaderSeedRef.current === loaderSeed) return;
		loaderSeedRef.current = loaderSeed;
		const next = retainedInventoryForSeed(loaderSeed);
		applyRetainedSnapshot(next);
	}, [applyRetainedSnapshot, loaderSeed]);

	useEffect(() => {
		if (
			loaderSeedRef.current !== loaderSeed ||
			inventoryStatusRef.current !== "unavailable" ||
			recoveryAttempted.current
		) {
			return;
		}
		recoveryAttempted.current = true;
		persistRetainedInventory();
		void refreshInventory();
	}, [loaderSeed, persistRetainedInventory, refreshInventory]);

	useEffect(() => {
		const codex = inventory.providers.find(
			(provider) => provider.id === "codex",
		);
		if (
			hostCapabilityRecoveryAttempted.current ||
			inventoryStatusRef.current === "loading" ||
			!codex ||
			codex.available === false ||
			codex.hostCapabilities?.windowsComputerUse
		) {
			return;
		}
		hostCapabilityRecoveryAttempted.current = true;
		persistRetainedInventory();
		const requestSeed = loaderSeedRef.current;
		void getProvidersFn({
			data: {
				includeHostCapabilities: true,
				waitForHostCapabilities: true,
				preferCachedModels: true,
			},
		})
			.then((providers) => {
				if (loaderSeedRef.current !== requestSeed) return;
				const recovered = providers.find(
					(provider) => provider.id === "codex",
				)?.hostCapabilities;
				if (!recovered?.windowsComputerUse) return;
				const current = retainedInventoryForSeed(requestSeed);
				commitInventory(current.inventory, current.inventoryStatus, recovered);
			})
			.catch(() => {});
	}, [inventory.providers, commitInventory, persistRetainedInventory]);

	const providers = useMemo(() => {
		if (!recoveredHostCapabilities?.windowsComputerUse) {
			return inventory.providers;
		}
		return inventory.providers.map((provider) =>
			provider.id === "codex" && !provider.hostCapabilities?.windowsComputerUse
				? { ...provider, hostCapabilities: recoveredHostCapabilities }
				: provider,
		);
	}, [inventory.providers, recoveredHostCapabilities]);
	const initial = useMemo(
		() => ({ ...loaded, ...inventory, providers }),
		[loaded, inventory, providers],
	);
	const state = useSettingsForm(initial, () => router.invalidate());
	return (
		<ForgeSettings
			initial={initial}
			state={state}
			navigation={navigation}
			onNavigationChange={navigateForge}
			inventoryStatus={inventoryStatus}
			onRetryInventory={() => refreshInventory(true)}
			onRefreshProviderOptions={refreshProviderOptions}
			onDiscoverAcpModels={discoverAcpModels}
			onAcpCatalogChange={commitAcpCatalog}
		/>
	);
}
