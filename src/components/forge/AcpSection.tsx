import { useEffect, useMemo, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { acpRuntimeIdentity } from "#/lib/acpRuntimeIdentity";
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
	savedValue = value,
	onChange,
	onRefreshProviders,
}: {
	initialCatalog: AcpCatalogItem[];
	value: NonNullable<HlidConfig["acp_agents"]>;
	savedValue?: NonNullable<HlidConfig["acp_agents"]>;
	onChange: (value: NonNullable<HlidConfig["acp_agents"]>) => void;
	onRefreshProviders?: (providerId: string) => void | Promise<void>;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState<{
		id: string;
		type: "inspect" | "refresh";
	} | null>(null);
	const [auth, setAuth] = useState<Record<string, AcpAuthMethod[]>>({});
	const [agentInfo, setAgentInfo] = useState<
		Record<string, AcpAgentInfo | null>
	>({});
	const [optionsRefreshed, setOptionsRefreshed] = useState<
		Record<string, boolean>
	>({});
	const [error, setError] = useState<string | null>(null);
	const [catalogRefreshing, setCatalogRefreshing] = useState(false);
	const operation = useRef<symbol | null>(null);
	useEffect(() => {
		setCatalog(initialCatalog);
		setAuth({});
		setAgentInfo({});
		setOptionsRefreshed({});
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
		setOptionsRefreshed((current) => ({ ...current, [item.id]: false }));
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
		setOptionsRefreshed((current) => ({ ...current, [id]: false }));
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
		setBusy({ id: item.id, type: "inspect" });
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
		setBusy({ id: item.id, type: "refresh" });
		setError(null);
		setOptionsRefreshed((current) => ({ ...current, [item.id]: false }));
		try {
			await onRefreshProviders(item.providerId);
			setOptionsRefreshed((current) => ({ ...current, [item.id]: true }));
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

	async function refreshCatalog(): Promise<void> {
		if (catalogRefreshing || busy !== null) return;
		setCatalogRefreshing(true);
		setError(null);
		try {
			const refreshed = await getAcpRegistryFn({ data: { refresh: true } });
			setCatalog(refreshed);
			setAuth({});
			setAgentInfo({});
			setOptionsRefreshed({});
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ACP catalog refresh failed",
			);
		} finally {
			setCatalogRefreshing(false);
		}
	}

	return (
		<Section title="OpenCode and ACP agents">
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
						disabled={catalogRefreshing || busy !== null}
						onClick={() => void refreshCatalog()}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase"
					>
						{catalogRefreshing ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				<p className="text-xs text-muted-foreground">
					Enabling, disabling, or changing an ACP agent applies immediately.
					Sessions using a removed or replaced agent are disconnected.
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
			{shown.map((item) => {
				const openCode = item.id === "opencode";
				const configured = value.find((candidate) => candidate.id === item.id);
				const savedConfigured = savedValue.find(
					(candidate) => candidate.id === item.id,
				);
				const configurationCurrent =
					Boolean(savedConfigured) &&
					acpRuntimeIdentity(configured ? [configured] : []) ===
						acpRuntimeIdentity(savedConfigured ? [savedConfigured] : []);
				return (
					<div
						key={item.id}
						className={
							openCode ? "border-y border-primary/30 bg-primary/5" : undefined
						}
					>
						<AcpAgentCard
							item={item}
							configured={configured}
							operation={busy?.id === item.id ? busy.type : null}
							disabled={busy !== null}
							authMethods={auth[item.id]}
							agentInfo={agentInfo[item.id]}
							optionsRefreshed={optionsRefreshed[item.id] ?? false}
							configurationCurrent={configurationCurrent}
							onToggle={() => toggle(item)}
							onUpdateOverride={(patch) => updateOverride(item.id, patch)}
							onInspect={(methodId) => void inspect(item, methodId)}
							onRefreshOptions={() => void refreshOptions(item)}
						/>
					</div>
				);
			})}
		</Section>
	);
}
