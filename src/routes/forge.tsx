import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ForgeSettings } from "#/components/forge/ForgeSettings";
import { getConfig } from "#/config";
import { useSettingsForm } from "#/hooks/useSettingsForm";
import { getAcpRegistryFn } from "#/lib/serverFns/acp";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns/providers";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd, providers, accountInfo, voiceInfo, acpCatalog] =
			await Promise.all([
				getConfig(),
				getCwdFn(),
				getProvidersFn(),
				getAccountInfoFn(),
				getVoiceInfoFn(),
				getAcpRegistryFn(),
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
