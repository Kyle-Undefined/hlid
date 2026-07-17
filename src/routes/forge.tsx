import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ForgeSettings } from "#/components/forge/ForgeSettings";
import { useSettingsForm } from "#/hooks/useSettingsForm";
import { optionalLoaderValue } from "#/lib/loaderFallback";
import { getAcpRegistryFn } from "#/lib/serverFns/acp";
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

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd, providers, accountInfo, voiceInfo, acpCatalog] =
			await Promise.all([
				getConfig(),
				getCwdFn(),
				optionalLoaderValue(
					getProvidersFn({
						data: {
							includeHostCapabilities: true,
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
					getAcpRegistryFn(),
					[],
					FORGE_OPTIONAL_LOADER_WAIT_MS,
				),
			]);
		const inventoryStatus = [
			providers,
			accountInfo,
			voiceInfo,
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
			acpCatalog: acpCatalog.value,
			inventoryStatus,
		};
	},
	component: SettingsPage,
});

function SettingsPage() {
	const loaded = Route.useLoaderData();
	const router = useRouter();
	const [inventory, setInventory] = useState(() => ({
		providers: loaded.providers,
		accountInfo: loaded.accountInfo,
		voiceInfo: loaded.voiceInfo,
		acpCatalog: loaded.acpCatalog,
	}));
	const [inventoryStatus, setInventoryStatus] = useState<
		"loading" | "ready" | "unavailable"
	>(loaded.inventoryStatus);

	const refreshInventory = useCallback(async (force = false) => {
		setInventoryStatus("loading");
		const [providers, accountInfo, voiceInfo, acpCatalog] = await Promise.all([
			optionalLoaderValue(
				getProvidersFn({
					data: {
						refresh: force,
						includeHostCapabilities: true,
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
			acpCatalog:
				acpCatalog.status === "ready" ? acpCatalog.value : current.acpCatalog,
		}));
		setInventoryStatus(
			[providers, accountInfo, voiceInfo, acpCatalog].every(
				(item) => item.status === "ready",
			)
				? "ready"
				: "unavailable",
		);
	}, []);

	useEffect(() => {
		if (loaded.inventoryStatus === "unavailable") void refreshInventory();
	}, [loaded.inventoryStatus, refreshInventory]);

	const initial = useMemo(
		() => ({ ...loaded, ...inventory }),
		[loaded, inventory],
	);
	const state = useSettingsForm(initial, () => router.invalidate());
	return (
		<ForgeSettings
			initial={initial}
			state={state}
			inventoryStatus={inventoryStatus}
			onRetryInventory={() => void refreshInventory(true)}
		/>
	);
}
