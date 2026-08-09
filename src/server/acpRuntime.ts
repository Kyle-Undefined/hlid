import type { HlidConfig } from "../config";
import { AcpProvider } from "./acpProvider";
import type { AcpCatalogItem } from "./acpRegistry";
import type { AgentProvider } from "./agentProvider";

export function acpRuntimeFingerprint(
	item: AcpCatalogItem,
	config: HlidConfig,
): string {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	return JSON.stringify({
		providerId: item.providerId,
		label: item.name,
		command: item.command,
		args: item.args,
		env: Object.fromEntries(
			Object.entries({ ...item.env, ...configured?.env }).sort(([a], [b]) =>
				a.localeCompare(b),
			),
		),
		discoveryCwd: config.vault.path || process.cwd(),
	});
}

export function createConfiguredAcpProvider(
	item: AcpCatalogItem,
	config: HlidConfig,
): AcpProvider {
	const configured = (config.acp_agents ?? []).find(
		(agent) => agent.id === item.id,
	);
	return new AcpProvider({
		id: item.providerId,
		label: item.name,
		command: item.command,
		args: item.args,
		env: { ...item.env, ...configured?.env },
		initialAvailability: {
			available: item.available,
			...(item.unavailableReason ? { reason: item.unavailableReason } : {}),
		},
		discoveryCwd: config.vault.path || process.cwd(),
		metadataCacheIdentity: acpRuntimeFingerprint(item, config),
	});
}

export type AcpRuntimeSyncResult = {
	added: string[];
	removed: string[];
	replaced: string[];
};

/** Reconcile only Hlid-managed registry ACP providers, preserving native providers. */
export async function syncAcpRuntimeProviders(options: {
	config: HlidConfig;
	catalog: AcpCatalogItem[];
	providers: Map<string, AgentProvider>;
	fingerprints: Map<string, string>;
	retireProviderSessions: (
		providerIds: Iterable<string>,
		options?: { preserveSelection?: boolean },
	) => void | Promise<void>;
	registerProvider: (provider: AgentProvider, replaced: boolean) => void;
}): Promise<AcpRuntimeSyncResult> {
	const desired = new Map(
		options.catalog
			.filter((item) => item.enabled)
			.map((item) => [
				item.providerId,
				{
					item,
					fingerprint: acpRuntimeFingerprint(item, options.config),
				},
			]),
	);
	const removed: string[] = [];
	const replaced: string[] = [];
	for (const [providerId, fingerprint] of options.fingerprints) {
		const next = desired.get(providerId);
		if (!next) removed.push(providerId);
		else if (next.fingerprint !== fingerprint) replaced.push(providerId);
	}
	for (const providerId of [...removed, ...replaced]) {
		options.providers.delete(providerId);
		options.fingerprints.delete(providerId);
	}
	if (removed.length > 0) await options.retireProviderSessions(removed);
	if (replaced.length > 0) {
		await options.retireProviderSessions(replaced, { preserveSelection: true });
	}

	const added: string[] = [];
	for (const [providerId, next] of desired) {
		if (options.fingerprints.has(providerId)) continue;
		const wasReplaced = replaced.includes(providerId);
		const provider = createConfiguredAcpProvider(next.item, options.config);
		options.providers.set(providerId, provider);
		options.fingerprints.set(providerId, next.fingerprint);
		options.registerProvider(provider, wasReplaced);
		if (!wasReplaced) added.push(providerId);
	}
	return { added, removed, replaced };
}
