import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ForgeSettings } from "#/components/forge/ForgeSettings";
import { useSettingsForm } from "#/hooks/useSettingsForm";
import { loaderValueOrFallback } from "#/lib/loaderFallback";
import { getAcpRegistryFn } from "#/lib/serverFns/acp";
import { getConfig } from "#/lib/serverFns/config";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns/providers";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());
const FORGE_OPTIONAL_LOADER_WAIT_MS = 500;
const UNAVAILABLE_VOICE_INFO = {
	status: {
		state: "unavailable" as const,
		model: "",
		error: "voice service unavailable",
	},
	models: [],
};

function optionalForgeLoaderValue<T>(
	read: Promise<T>,
	fallback: T,
): Promise<T> {
	return loaderValueOrFallback(read, fallback, FORGE_OPTIONAL_LOADER_WAIT_MS);
}

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd, providers, accountInfo, voiceInfo, acpCatalog] =
			await Promise.all([
				getConfig(),
				getCwdFn(),
				optionalForgeLoaderValue(
					getProvidersFn({
						data: {
							includeHostCapabilities: true,
							preferCachedModels: true,
						},
					}),
					[],
				),
				optionalForgeLoaderValue(getAccountInfoFn(), null),
				optionalForgeLoaderValue(getVoiceInfoFn(), UNAVAILABLE_VOICE_INFO),
				optionalForgeLoaderValue(getAcpRegistryFn(), []),
			]);
		return { ...config, cwd, providers, accountInfo, voiceInfo, acpCatalog };
	},
	component: SettingsPage,
});

function SettingsPage() {
	const initial = Route.useLoaderData();
	const router = useRouter();
	const state = useSettingsForm(initial, () => router.invalidate());
	return <ForgeSettings initial={initial} state={state} />;
}
