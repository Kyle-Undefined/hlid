export type McpRegistrySource =
	| "vault"
	| "agent"
	| "provider"
	| "runtime"
	| "managed";

export type McpRegistryEntry = {
	name: string;
	providerId: string;
	status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
	scope: "vault" | "agent" | "provider" | "managed";
	source: McpRegistrySource;
	error?: string;
};

const SOURCE_PRECEDENCE: Record<McpRegistrySource, number> = {
	vault: 0,
	agent: 1,
	managed: 2,
	provider: 3,
	runtime: 4,
};

/**
 * Merge configuration and live discovery into one scoped inventory. Runtime
 * truth wins without erasing where a server was configured.
 */
export function mergeMcpRegistry(
	entries: McpRegistryEntry[],
): McpRegistryEntry[] {
	const merged = new Map<string, McpRegistryEntry>();
	for (const entry of entries) {
		const key = `${entry.providerId.toLowerCase()}:${entry.name.toLowerCase()}`;
		const current = merged.get(key);
		if (
			current?.status === "disabled" &&
			(current.source === "vault" ||
				current.source === "agent" ||
				current.source === "managed")
		) {
			continue;
		}
		if (
			!current ||
			SOURCE_PRECEDENCE[entry.source] >= SOURCE_PRECEDENCE[current.source]
		) {
			merged.set(key, {
				...entry,
				// Preserve the owning configuration scope when discovery overlays it.
				scope:
					(entry.source === "provider" || entry.source === "runtime") &&
					current &&
					(current.source === "vault" ||
						current.source === "agent" ||
						current.source === "managed")
						? current.scope
						: entry.scope,
			});
		}
	}
	return [...merged.values()].sort(
		(a, b) =>
			a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name),
	);
}
