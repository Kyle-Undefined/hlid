import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ForgeSettings } from "#/components/forge/ForgeSettings";
import { useSettingsForm } from "#/hooks/useSettingsForm";
import {
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
	const routeSearch = Route.useSearch();
	const navigate = useNavigate({ from: "/forge" });
	const router = useRouter();
	const navigation = normalizeForgeNavigation(routeSearch);
	const [inventory, setInventory] = useState(() => ({
		providers: loaded.providers,
		accountInfo: loaded.accountInfo,
		voiceInfo: loaded.voiceInfo,
		cliProxyInfo: loaded.cliProxyInfo,
		acpCatalog: loaded.acpCatalog,
	}));
	const [inventoryStatus, setInventoryStatus] = useState<
		"loading" | "ready" | "unavailable"
	>(loaded.inventoryStatus);

	const refreshInventory = useCallback(async (force = false) => {
		setInventoryStatus("loading");
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
		setInventory((current) => ({
			providers:
				providers.status === "ready" ? providers.value : current.providers,
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
		}));
		setInventoryStatus(
			[providers, accountInfo, voiceInfo, cliProxyInfo, acpCatalog].every(
				(item) => item.status === "ready",
			)
				? "ready"
				: "unavailable",
		);
	}, []);
	const refreshProviderOptions = useCallback(async (providerId: string) => {
		const providers = await getProvidersFn({
			data: {
				refresh: true,
				refreshProviderId: providerId,
				includeHostCapabilities: true,
				includeProviderCapabilities: true,
				preferCachedModels: false,
			},
		});
		setInventory((current) => ({ ...current, providers }));
		const error = providerOptionRefreshError(providerId, providers);
		if (error) throw error;
	}, []);
	const discoverAcpModels = useCallback(
		(id: string) => discoverAcpModelsFn({ data: { id } }),
		[],
	);
	const navigateForge = useCallback(
		(next: ForgeNavigationState) => {
			void navigate({
				search: forgeSearchFromNavigation(next),
				resetScroll: false,
			});
		},
		[navigate],
	);

	useEffect(() => {
		setInventory({
			providers: loaded.providers,
			accountInfo: loaded.accountInfo,
			voiceInfo: loaded.voiceInfo,
			cliProxyInfo: loaded.cliProxyInfo,
			acpCatalog: loaded.acpCatalog,
		});
		setInventoryStatus(loaded.inventoryStatus);
		if (loaded.inventoryStatus === "unavailable") void refreshInventory();
	}, [
		loaded.providers,
		loaded.accountInfo,
		loaded.voiceInfo,
		loaded.cliProxyInfo,
		loaded.acpCatalog,
		loaded.inventoryStatus,
		refreshInventory,
	]);

	const initial = useMemo(
		() => ({ ...loaded, ...inventory }),
		[loaded, inventory],
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
		/>
	);
}
