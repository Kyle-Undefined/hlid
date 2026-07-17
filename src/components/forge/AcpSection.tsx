import { useMemo, useState } from "react";
import type { HlidConfig } from "#/config";
import { includesSearchText } from "#/lib/search";
import {
	type AcpAuthMethod,
	type AcpCatalogItem,
	authenticateAcpFn,
	getAcpRegistryFn,
} from "#/lib/serverFns/acp";
import { AcpAgentCard } from "./AcpAgentCard";
import { Section } from "./fields";

export function AcpSection({
	initialCatalog,
	value,
	onChange,
}: {
	initialCatalog: AcpCatalogItem[];
	value: NonNullable<HlidConfig["acp_agents"]>;
	onChange: (value: NonNullable<HlidConfig["acp_agents"]>) => void;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [auth, setAuth] = useState<Record<string, AcpAuthMethod[]>>({});
	const [error, setError] = useState<string | null>(null);
	const shown = useMemo(() => {
		const query = search.trim();
		return query
			? catalog.filter((item) =>
					includesSearchText(`${item.name} ${item.description}`, query),
				)
			: catalog;
	}, [catalog, search]);

	function toggle(item: AcpCatalogItem): void {
		const enabled = value.some((candidate) => candidate.id === item.id);
		onChange(
			enabled
				? value.filter((candidate) => candidate.id !== item.id)
				: [...value, { id: item.id }],
		);
	}

	function updateOverride(
		id: string,
		patch: Partial<NonNullable<HlidConfig["acp_agents"]>[number]>,
	): void {
		onChange(
			value.map((candidate) =>
				candidate.id === id ? { ...candidate, ...patch } : candidate,
			),
		);
	}

	async function inspect(
		item: AcpCatalogItem,
		methodId?: string,
	): Promise<void> {
		setBusy(item.id);
		setError(null);
		try {
			const result = await authenticateAcpFn({
				data: { id: item.id, methodId },
			});
			setAuth((current) => ({ ...current, [item.id]: result.authMethods }));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ACP authentication failed",
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<Section title="Agent Client Protocol Catalog">
			<div className="px-4 py-3 space-y-2">
				<div className="flex gap-2">
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search ACP agents"
						className="min-w-0 flex-1 bg-secondary border border-border px-2.5 py-1.5 text-xs"
					/>
					<button
						type="button"
						onClick={() =>
							void getAcpRegistryFn({ data: { refresh: true } }).then(
								setCatalog,
							)
						}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase"
					>
						Refresh
					</button>
				</div>
				<p className="text-xs text-muted-foreground">
					Enabling an agent saves its configuration and requires a Hlid restart.
					Installation commands are guidance only and are never run
					automatically.
				</p>
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
			{shown.map((item) => (
				<AcpAgentCard
					key={item.id}
					item={item}
					configured={value.find((candidate) => candidate.id === item.id)}
					busy={busy === item.id}
					authMethods={auth[item.id]}
					onToggle={() => toggle(item)}
					onUpdateOverride={(patch) => updateOverride(item.id, patch)}
					onInspect={(methodId) => void inspect(item, methodId)}
				/>
			))}
		</Section>
	);
}
