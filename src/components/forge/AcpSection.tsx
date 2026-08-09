import { useEffect, useMemo, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { includesSearchText } from "#/lib/search";
import {
	type AcpAgentInfo,
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
	onRefreshProviders,
}: {
	initialCatalog: AcpCatalogItem[];
	value: NonNullable<HlidConfig["acp_agents"]>;
	onChange: (value: NonNullable<HlidConfig["acp_agents"]>) => void;
	onRefreshProviders?: (providerId: string) => void | Promise<void>;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [auth, setAuth] = useState<Record<string, AcpAuthMethod[]>>({});
	const [agentInfo, setAgentInfo] = useState<
		Record<string, AcpAgentInfo | null>
	>({});
	const [error, setError] = useState<string | null>(null);
	const operation = useRef<symbol | null>(null);
	useEffect(() => {
		setCatalog(initialCatalog);
		setAuth({});
		setAgentInfo({});
	}, [initialCatalog]);
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
		setAuth((current) => ({ ...current, [item.id]: [] }));
		setAgentInfo((current) => ({ ...current, [item.id]: null }));
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
		setAuth((current) => ({ ...current, [id]: [] }));
		setAgentInfo((current) => ({ ...current, [id]: null }));
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
		if (operation.current) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy(item.id);
		setError(null);
		setAuth((current) => ({ ...current, [item.id]: [] }));
		setAgentInfo((current) => ({ ...current, [item.id]: null }));
		try {
			const result = await authenticateAcpFn({
				data: { id: item.id, methodId },
			});
			setAuth((current) => ({ ...current, [item.id]: result.authMethods }));
			setAgentInfo((current) => ({
				...current,
				[item.id]: result.agentInfo,
			}));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ACP authentication failed",
			);
		} finally {
			if (operation.current === token) {
				operation.current = null;
				setBusy(null);
			}
		}
	}

	async function refreshOptions(item: AcpCatalogItem): Promise<void> {
		if (!onRefreshProviders) return;
		if (operation.current) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy(item.id);
		setError(null);
		try {
			await onRefreshProviders(item.providerId);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ACP option refresh failed",
			);
		} finally {
			if (operation.current === token) {
				operation.current = null;
				setBusy(null);
			}
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
						className="min-w-0 flex-1 bg-input border border-border px-2.5 py-1.5 text-xs"
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
				<p className="text-xs text-muted-foreground">
					ACP agents decide which native actions they report for approval and
					whether they connect client-provided MCP servers. Hlid can enforce
					only the approval requests and tool connections the agent actually
					exposes.
				</p>
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
			{shown.map((item) => (
				<AcpAgentCard
					key={item.id}
					item={item}
					configured={value.find((candidate) => candidate.id === item.id)}
					busy={busy === item.id}
					disabled={busy !== null}
					authMethods={auth[item.id]}
					agentInfo={agentInfo[item.id]}
					onToggle={() => toggle(item)}
					onUpdateOverride={(patch) => updateOverride(item.id, patch)}
					onInspect={(methodId) => void inspect(item, methodId)}
					onRefreshOptions={() => void refreshOptions(item)}
				/>
			))}
		</Section>
	);
}
