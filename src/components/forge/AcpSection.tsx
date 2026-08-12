import { useEffect, useMemo, useRef, useState } from "react";
import type { HlidConfig } from "#/config";
import { mutateAcpManagedInstallation } from "#/lib/acpManagedClient";
import type { AcpManagedMutationAction } from "#/lib/acpManagedTypes";
import { acpRuntimeIdentity } from "#/lib/acpRuntimeIdentity";
import type { ProviderInfo } from "#/lib/providerTypes";
import { includesSearchText } from "#/lib/search";
import {
	type AcpAgentInfo,
	type AcpAuthMethod,
	type AcpCatalogItem,
	type AcpProviderNativeSessionPage,
	type AcpProviderSessionImportResult,
	authenticateAcpFn,
	getAcpRegistryFn,
	importAcpProviderSessionFn,
	listAcpProviderSessionsFn,
} from "#/lib/serverFns/acp";
import { AcpAgentCard } from "./AcpAgentCard";
import { Section } from "./fields";

const MAX_PROVIDER_SESSION_BROWSER_PAGES = 25;

function preferredTargetId(item: AcpCatalogItem): string {
	const managed = item.targets.filter(
		(target) => target.provenance === "managed",
	);
	return (
		item.targets.find((target) => target.operation)?.targetId ??
		item.targets.find((target) => target.selected)?.targetId ??
		(managed.length === 1 ? managed[0]?.targetId : undefined) ??
		item.targets.find((target) => target.recommended)?.targetId ??
		item.targets[0]?.targetId ??
		""
	);
}

function selectedTargetIds(
	catalog: AcpCatalogItem[],
	current: Record<string, string> = {},
): Record<string, string> {
	return Object.fromEntries(
		catalog.map((item) => {
			const configured = item.targets.find(
				(target) => target.selected,
			)?.targetId;
			const retained = item.targets.some(
				(target) => target.targetId === current[item.id],
			)
				? current[item.id]
				: undefined;
			return [
				item.id,
				item.enabled
					? (configured ?? retained ?? preferredTargetId(item))
					: (retained ?? configured ?? preferredTargetId(item)),
			];
		}),
	);
}

export function AcpSection({
	initialCatalog,
	value,
	savedValue = value,
	workspaceConfigurationCurrent = true,
	providers = [],
	onChange,
	onCatalogChange,
	onRefreshProviders,
	onDiscoverModels,
}: {
	initialCatalog: AcpCatalogItem[];
	value: NonNullable<HlidConfig["acp_agents"]>;
	savedValue?: NonNullable<HlidConfig["acp_agents"]>;
	workspaceConfigurationCurrent?: boolean;
	providers?: ProviderInfo[];
	onChange: (value: NonNullable<HlidConfig["acp_agents"]>) => void;
	onCatalogChange?: (catalog: AcpCatalogItem[]) => void;
	onRefreshProviders?: (providerId: string) => void | Promise<void>;
	onDiscoverModels?: (item: AcpCatalogItem) => Promise<ProviderInfo["models"]>;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState<{
		id: string;
		type:
			| "inspect"
			| "refresh"
			| "sessions"
			| "import"
			| AcpManagedMutationAction;
		providerSessionId?: string;
	} | null>(null);
	const [selectedTargets, setSelectedTargets] = useState<
		Record<string, string>
	>(() => selectedTargetIds(initialCatalog));
	const [auth, setAuth] = useState<Record<string, AcpAuthMethod[]>>({});
	const [agentInfo, setAgentInfo] = useState<
		Record<string, AcpAgentInfo | null>
	>({});
	const [optionsRefreshed, setOptionsRefreshed] = useState<
		Record<string, boolean>
	>({});
	const [canListSessions, setCanListSessions] = useState<
		Record<string, boolean | undefined>
	>({});
	const [providerSessions, setProviderSessions] = useState<
		Record<string, AcpProviderNativeSessionPage | null | undefined>
	>({});
	const [providerSessionImports, setProviderSessionImports] = useState<
		Record<string, Record<string, AcpProviderSessionImportResult>>
	>({});
	const providerSessionCursors = useRef<Record<string, Set<string>>>({});
	const providerSessionPageCounts = useRef<Record<string, number>>({});
	const [error, setError] = useState<string | null>(null);
	const [catalogRefreshing, setCatalogRefreshing] = useState(false);
	const operation = useRef<symbol | null>(null);
	useEffect(() => {
		setCatalog(initialCatalog);
		setSelectedTargets((current) => selectedTargetIds(initialCatalog, current));
		setAuth({});
		setAgentInfo({});
		setOptionsRefreshed({});
		setCanListSessions({});
		setProviderSessions({});
		setProviderSessionImports({});
		providerSessionCursors.current = {};
		providerSessionPageCounts.current = {};
	}, [initialCatalog]);
	const managedOperationActive = catalog.some((item) =>
		item.targets.some((target) => Boolean(target.operation)),
	);
	useEffect(() => {
		if (!managedOperationActive) return;
		let active = true;
		let polling = false;
		const poll = async () => {
			if (polling) return;
			polling = true;
			try {
				const refreshed = await getAcpRegistryFn();
				if (!active) return;
				setCatalog(refreshed);
				onCatalogChange?.(refreshed);
				setSelectedTargets((current) => selectedTargetIds(refreshed, current));
			} catch {
				// Keep the last operation snapshot visible and retry on the next tick.
			} finally {
				polling = false;
			}
		};
		const timer = window.setInterval(() => void poll(), 1_000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [managedOperationActive, onCatalogChange]);
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
		const selectedTarget = item.targets.find(
			(target) => target.targetId === selectedTargets[item.id],
		);
		const canConfigureExternal =
			selectedTarget?.provenance === "missing" && !selectedTarget.canInstall;
		if (!enabled && !selectedTarget?.canEnable && !canConfigureExternal) return;
		setAuth((current) => ({ ...current, [item.id]: [] }));
		setAgentInfo((current) => ({ ...current, [item.id]: null }));
		setOptionsRefreshed((current) => ({ ...current, [item.id]: false }));
		setCanListSessions((current) => ({
			...current,
			[item.id]: undefined,
		}));
		setProviderSessions((current) => ({ ...current, [item.id]: null }));
		setProviderSessionImports((current) => ({
			...current,
			[item.id]: {},
		}));
		onChange(
			enabled
				? value.filter((candidate) => candidate.id !== item.id)
				: [...value, { id: item.id, target: selectedTarget?.target }],
		);
	}

	async function mutateManagedInstallation(
		item: AcpCatalogItem,
		targetId: string,
		action: AcpManagedMutationAction,
	): Promise<void> {
		if (operation.current || managedOperationActive) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy({ id: item.id, type: action });
		setError(null);
		try {
			const target = item.targets.find(
				(candidate) => candidate.targetId === targetId,
			);
			if (!target) throw new Error("ACP execution target is unavailable");
			const managedOperation = await mutateAcpManagedInstallation({
				action,
				agentId: item.id,
				targetId,
				revision: target.mutationRevision,
			});
			const nextCatalog = catalog.map((candidate) =>
				candidate.id !== item.id
					? candidate
					: {
							...candidate,
							targets: candidate.targets.map((target) =>
								target.targetId === targetId
									? { ...target, operation: managedOperation }
									: target,
							),
						},
			);
			setCatalog(nextCatalog);
			onCatalogChange?.(nextCatalog);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : `ACP ${action} failed`);
		} finally {
			if (operation.current === token) {
				operation.current = null;
				setBusy(null);
			}
		}
	}

	function updateOverride(
		id: string,
		patch: Partial<NonNullable<HlidConfig["acp_agents"]>[number]>,
	): void {
		setAuth((current) => ({ ...current, [id]: [] }));
		setAgentInfo((current) => ({ ...current, [id]: null }));
		setOptionsRefreshed((current) => ({ ...current, [id]: false }));
		setCanListSessions((current) => ({ ...current, [id]: undefined }));
		setProviderSessions((current) => ({ ...current, [id]: null }));
		setProviderSessionImports((current) => ({ ...current, [id]: {} }));
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
		if (operation.current || managedOperationActive) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy({ id: item.id, type: "inspect" });
		setError(null);
		setAuth((current) => ({ ...current, [item.id]: [] }));
		setAgentInfo((current) => ({ ...current, [item.id]: null }));
		setCanListSessions((current) => ({
			...current,
			[item.id]: undefined,
		}));
		setProviderSessions((current) => ({ ...current, [item.id]: null }));
		setProviderSessionImports((current) => ({
			...current,
			[item.id]: {},
		}));
		try {
			const result = await authenticateAcpFn({
				data: { id: item.id, methodId },
			});
			setAuth((current) => ({ ...current, [item.id]: result.authMethods }));
			setAgentInfo((current) => ({
				...current,
				[item.id]: result.agentInfo,
			}));
			setCanListSessions((current) => ({
				...current,
				[item.id]: result.canListSessions,
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

	async function browseProviderSessions(
		item: AcpCatalogItem,
		cursor?: string,
	): Promise<void> {
		if (operation.current) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy({ id: item.id, type: "sessions" });
		setError(null);
		try {
			if (!cursor) {
				providerSessionCursors.current[item.id] = new Set();
				providerSessionPageCounts.current[item.id] = 0;
			} else if (providerSessionCursors.current[item.id]?.has(cursor)) {
				throw new Error("The provider returned a repeated session cursor");
			}
			const page = await listAcpProviderSessionsFn({
				data: { id: item.id, ...(cursor ? { cursor } : {}) },
			});
			if (cursor) {
				const seenCursors =
					providerSessionCursors.current[item.id] ?? new Set<string>();
				seenCursors.add(cursor);
				providerSessionCursors.current[item.id] = seenCursors;
			}
			const pageCount = (providerSessionPageCounts.current[item.id] ?? 0) + 1;
			providerSessionPageCounts.current[item.id] = pageCount;
			const nextCursor =
				page.nextCursor &&
				pageCount < MAX_PROVIDER_SESSION_BROWSER_PAGES &&
				!providerSessionCursors.current[item.id]?.has(page.nextCursor)
					? page.nextCursor
					: undefined;
			if (page.nextCursor && !nextCursor) {
				setError(
					pageCount >= MAX_PROVIDER_SESSION_BROWSER_PAGES
						? `Provider session browsing is limited to ${MAX_PROVIDER_SESSION_BROWSER_PAGES} pages per inspection.`
						: "The provider returned a repeated session cursor.",
				);
			}
			setProviderSessions((current) => {
				const previous = current[item.id];
				if (!cursor || !previous) {
					return {
						...current,
						[item.id]: {
							sessions: page.sessions,
							canImportSessions: page.canImportSessions,
							...(nextCursor ? { nextCursor } : {}),
						},
					};
				}
				const known = new Set(
					previous.sessions.map((session) => session.sessionId),
				);
				return {
					...current,
					[item.id]: {
						sessions: [
							...previous.sessions,
							...page.sessions.filter(
								(session) => !known.has(session.sessionId),
							),
						],
						canImportSessions:
							previous.canImportSessions && page.canImportSessions,
						...(nextCursor ? { nextCursor } : {}),
					},
				};
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "ACP provider session listing failed",
			);
		} finally {
			if (operation.current === token) {
				operation.current = null;
				setBusy(null);
			}
		}
	}

	async function importProviderSession(
		item: AcpCatalogItem,
		providerSessionId: string,
	): Promise<void> {
		if (operation.current) return;
		const token = Symbol(item.id);
		operation.current = token;
		setBusy({ id: item.id, type: "import", providerSessionId });
		setError(null);
		try {
			const result = await importAcpProviderSessionFn({
				data: { id: item.id, providerSessionId },
			});
			setProviderSessionImports((current) => ({
				...current,
				[item.id]: {
					...current[item.id],
					[providerSessionId]: result,
				},
			}));
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "ACP provider session import failed",
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
		if (operation.current || managedOperationActive) return;
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
		if (catalogRefreshing || busy !== null || managedOperationActive) return;
		setCatalogRefreshing(true);
		setError(null);
		try {
			const refreshed = await getAcpRegistryFn({ data: { refresh: true } });
			setCatalog(refreshed);
			onCatalogChange?.(refreshed);
			setSelectedTargets((current) => selectedTargetIds(refreshed, current));
			setAuth({});
			setAgentInfo({});
			setOptionsRefreshed({});
			setCanListSessions({});
			setProviderSessions({});
			setProviderSessionImports({});
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
						disabled={
							catalogRefreshing || busy !== null || managedOperationActive
						}
						onClick={() => void refreshCatalog()}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase"
					>
						{catalogRefreshing ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				<p className="text-xs text-muted-foreground">
					Enabling, disabling, or changing an ACP agent applies immediately.
					Sessions using a removed or replaced agent are disconnected.
					Hlid-managed installations require confirmation. Installation and
					execution use the exact environment selected for each agent.
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
				const selectedTargetId =
					selectedTargets[item.id] ?? preferredTargetId(item);
				const savedConfigured = savedValue.find(
					(candidate) => candidate.id === item.id,
				);
				const managedMutationConfigurationCurrent =
					workspaceConfigurationCurrent &&
					acpRuntimeIdentity(configured ? [configured] : []) ===
						acpRuntimeIdentity(savedConfigured ? [savedConfigured] : []);
				const configurationCurrent =
					managedMutationConfigurationCurrent &&
					Boolean(savedConfigured) &&
					Boolean(configured);
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
							selectedTargetId={selectedTargetId}
							operation={busy?.id === item.id ? busy.type : null}
							disabled={busy !== null || managedOperationActive}
							authMethods={auth[item.id]}
							agentInfo={agentInfo[item.id]}
							canListSessions={canListSessions[item.id]}
							providerSessions={providerSessions[item.id]}
							providerSessionImports={providerSessionImports[item.id]}
							importingProviderSessionId={
								busy?.id === item.id && busy.type === "import"
									? busy.providerSessionId
									: undefined
							}
							models={
								providers.find((provider) => provider.id === item.providerId)
									?.models
							}
							onDiscoverModels={
								onDiscoverModels ? () => onDiscoverModels(item) : undefined
							}
							optionsRefreshed={optionsRefreshed[item.id] ?? false}
							configurationCurrent={configurationCurrent}
							managedMutationConfigurationCurrent={
								managedMutationConfigurationCurrent
							}
							onToggle={() => toggle(item)}
							onSelectTarget={(targetId) =>
								setSelectedTargets((current) => ({
									...current,
									[item.id]: targetId,
								}))
							}
							onManagedMutation={(action) =>
								void mutateManagedInstallation(item, selectedTargetId, action)
							}
							onUpdateOverride={(patch) => updateOverride(item.id, patch)}
							onInspect={(methodId) => void inspect(item, methodId)}
							onRefreshOptions={() => void refreshOptions(item)}
							onBrowseProviderSessions={(cursor) =>
								void browseProviderSessions(item, cursor)
							}
							onCloseProviderSessions={() =>
								setProviderSessions((current) => ({
									...current,
									[item.id]: null,
								}))
							}
							onImportProviderSession={(providerSessionId) =>
								void importProviderSession(item, providerSessionId)
							}
						/>
					</div>
				);
			})}
		</Section>
	);
}
