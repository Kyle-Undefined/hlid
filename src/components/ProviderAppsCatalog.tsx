import { Blocks, RefreshCw, X } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type {
	ProviderAppCatalogPage,
	ProviderAppInventoryItem,
	ProviderConnectorInventoryItem,
} from "#/lib/providerAppTypes";
import { includesSearchText } from "#/lib/search";
import {
	authenticateProviderAppFn,
	getProviderAppsFn,
} from "#/lib/serverFns/providerApps";
import { semanticStatusClass } from "#/lib/themeClasses";

type CatalogTab = "installed" | "available" | "connectors";
type PendingTarget = { kind: "app" | "mcp"; id: string };

function mergeApps(
	current: ProviderAppInventoryItem[],
	incoming: ProviderAppInventoryItem[],
): ProviderAppInventoryItem[] {
	const byId = new Map(current.map((item) => [item.id, item]));
	for (const item of incoming) byId.set(item.id, item);
	return [...byId.values()];
}

function statusClass(ok: boolean | null): string {
	return ok === true
		? semanticStatusClass.success.text
		: ok === false
			? semanticStatusClass.warning.text
			: "text-muted-foreground/50";
}

function StateBadge({
	children,
	ok,
}: {
	children: ReactNode;
	ok: boolean | null;
}) {
	return (
		<span className={`text-[8px] tracking-widest uppercase ${statusClass(ok)}`}>
			{children}
		</span>
	);
}

function AppRow({
	app,
	busy,
	onAuthenticate,
}: {
	app: ProviderAppInventoryItem;
	busy: boolean;
	onAuthenticate: () => void;
}) {
	return (
		<div className="px-4 py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span
					className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
						app.usable
							? semanticStatusClass.success.dot
							: app.authentication === "required"
								? semanticStatusClass.warning.dot
								: "bg-muted-foreground/30"
					}`}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className="min-w-0 break-words text-sm text-foreground">
							{app.name}
						</span>
						<StateBadge ok={app.installed}>installed</StateBadge>
						<StateBadge ok={app.configured}>configured</StateBadge>
						<StateBadge
							ok={
								app.authentication === "ready"
									? true
									: app.authentication === "required"
										? false
										: null
							}
						>
							auth {app.authentication}
						</StateBadge>
						<StateBadge ok={app.usable}>usable</StateBadge>
					</div>
					{app.description && (
						<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
							{app.description}
						</p>
					)}
					{app.reason && (
						<p className="mt-1 text-[10px] text-muted-foreground/65">
							{app.reason}
						</p>
					)}
					<div className="mt-1 break-all font-mono text-[8px] text-muted-foreground/35">
						{app.id}
						{app.distributionChannel ? ` · ${app.distributionChannel}` : ""}
					</div>
				</div>
				{app.canAuthenticate && !app.usable && (
					<button
						type="button"
						disabled={busy}
						onClick={onAuthenticate}
						className="shrink-0 border border-border px-2.5 py-1 text-[9px] tracking-widest uppercase hover:bg-accent disabled:opacity-40"
					>
						{busy || app.oauthState === "pending" ? "waiting…" : "connect"}
					</button>
				)}
			</div>
		</div>
	);
}

function ConnectorRow({
	connector,
	busy,
	onAuthenticate,
}: {
	connector: ProviderConnectorInventoryItem;
	busy: boolean;
	onAuthenticate: () => void;
}) {
	return (
		<div className="px-4 py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span
					className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
						connector.usable
							? semanticStatusClass.success.dot
							: connector.authentication === "required"
								? semanticStatusClass.warning.dot
								: "bg-muted-foreground/30"
					}`}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="text-sm text-foreground">{connector.name}</span>
						<StateBadge
							ok={
								connector.authentication === "required"
									? false
									: connector.authentication === "unknown"
										? null
										: true
							}
						>
							auth {connector.authentication}
						</StateBadge>
						<StateBadge ok={connector.usable}>usable</StateBadge>
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground/65">
						{connector.toolCount} tools · {connector.resourceCount} resources ·{" "}
						{connector.resourceTemplateCount} templates
					</div>
					{connector.reason && (
						<p className="mt-1 text-[10px] text-muted-foreground/65">
							{connector.reason}
						</p>
					)}
					<div className="mt-1 break-all font-mono text-[8px] text-muted-foreground/35">
						{connector.id}
					</div>
				</div>
				{connector.canAuthenticate && (
					<button
						type="button"
						disabled={busy}
						onClick={onAuthenticate}
						className="shrink-0 border border-border px-2.5 py-1 text-[9px] tracking-widest uppercase hover:bg-accent disabled:opacity-40"
					>
						{busy || connector.oauthState === "pending"
							? "waiting…"
							: "authenticate"}
					</button>
				)}
			</div>
		</div>
	);
}

export function ProviderAppsCatalog({
	providerId,
	providerLabel,
	cwd,
	sessionId,
}: {
	providerId: string;
	providerLabel: string;
	cwd?: string;
	sessionId?: string;
}) {
	const [catalog, setCatalog] = useState<ProviderAppCatalogPage | null>(null);
	const [loadedApps, setLoadedApps] = useState<ProviderAppInventoryItem[]>([]);
	const [tab, setTab] = useState<CatalogTab>("installed");
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingTarget, setPendingTarget] = useState<PendingTarget | null>(
		null,
	);

	const load = useCallback(
		async (options: { cursor?: string; refresh?: boolean } = {}) => {
			const more = Boolean(options.cursor);
			if (more) setLoadingMore(true);
			else setLoading(true);
			setError(null);
			try {
				const next = await getProviderAppsFn({
					data: {
						providerId,
						...(cwd ? { cwd } : {}),
						...(sessionId ? { sessionId } : {}),
						...(options.cursor ? { cursor: options.cursor } : {}),
						limit: 50,
						...(options.refresh ? { refresh: true } : {}),
					},
				});
				setCatalog(next);
				setLoadedApps((current) =>
					more ? mergeApps(current, next.apps) : next.apps,
				);
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Provider app inventory is unavailable.",
				);
			} finally {
				setLoading(false);
				setLoadingMore(false);
			}
		},
		[cwd, providerId, sessionId],
	);

	useEffect(() => {
		setCatalog(null);
		setLoadedApps([]);
		setPendingTarget(null);
		setNotice(null);
		void load();
	}, [load]);

	useEffect(() => {
		if (!pendingTarget || !catalog) return;
		const item =
			pendingTarget.kind === "app"
				? catalog.apps.find((candidate) => candidate.id === pendingTarget.id)
				: catalog.connectors.find(
						(candidate) => candidate.id === pendingTarget.id,
					);
		if (item?.oauthState === "complete" || item?.usable) {
			setNotice(
				"Provider authentication completed and the integration is usable.",
			);
			setPendingTarget(null);
		} else if (item?.oauthState === "failed") {
			setNotice("Provider authentication did not complete. You can try again.");
			setPendingTarget(null);
		}
	}, [catalog, pendingTarget]);

	useEffect(() => {
		if (!pendingTarget) return;
		const timer = setInterval(() => void load({ refresh: true }), 3_000);
		return () => clearInterval(timer);
	}, [load, pendingTarget]);

	async function authenticate(target: PendingTarget): Promise<void> {
		setPendingTarget(target);
		setError(null);
		setNotice(
			"Complete authentication in the browser. Hlid will refresh automatically.",
		);
		try {
			await authenticateProviderAppFn({
				data: {
					providerId,
					...(cwd ? { cwd } : {}),
					kind: target.kind,
					id: target.id,
				},
			});
			void load({ refresh: true });
		} catch (cause) {
			setPendingTarget(null);
			setNotice(null);
			setError(
				cause instanceof Error
					? cause.message
					: "Provider authentication could not be started.",
			);
		}
	}

	const filteredApps = useMemo(() => {
		const installed = tab === "installed";
		return loadedApps.filter((app) => {
			if (tab === "connectors") return false;
			if (app.installed !== installed) return false;
			return (
				!query.trim() ||
				includesSearchText(`${app.name} ${app.description ?? ""}`, query)
			);
		});
	}, [loadedApps, query, tab]);
	const filteredConnectors = useMemo(
		() =>
			(catalog?.connectors ?? []).filter(
				(connector) =>
					!query.trim() || includesSearchText(connector.name, query),
			),
		[catalog?.connectors, query],
	);

	return (
		<div className="min-w-0 space-y-3">
			<div className="border border-border bg-card">
				<div className="flex min-w-0 flex-col gap-3 border-b border-border px-4 py-3 @2xl:flex-row @2xl:items-center">
					<div className="min-w-0 flex-1">
						<div className="text-sm text-foreground">{providerLabel}</div>
						<div className="mt-0.5 text-[9px] tracking-wider text-muted-foreground/55 uppercase">
							active provider account · current Hlid host ·{" "}
							{catalog?.scope.sessionId ? "active Raven session" : "no session"}
						</div>
						{catalog?.scope.workspace && (
							<div className="mt-1 truncate font-mono text-[8px] text-muted-foreground/35">
								{catalog.scope.workspace}
							</div>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-3 text-[9px] text-muted-foreground/65">
						<span>{catalog?.installedCount ?? 0} installed</span>
						<span>{catalog?.usableCount ?? 0} usable</span>
						<span>{catalog?.missingAuthenticationCount ?? 0} need auth</span>
						<button
							type="button"
							disabled={loading}
							onClick={() => void load({ refresh: true })}
							className="inline-flex items-center gap-1 text-[9px] tracking-widest uppercase hover:text-foreground disabled:opacity-40"
						>
							<RefreshCw
								className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
							/>
							refresh
						</button>
					</div>
				</div>
				<div className="flex min-w-0 flex-col gap-2 px-4 py-3 @2xl:flex-row @2xl:items-center">
					<div className="flex flex-wrap gap-1">
						{(["installed", "available", "connectors"] as const).map(
							(value) => (
								<button
									key={value}
									type="button"
									onClick={() => setTab(value)}
									className={`px-2.5 py-1 text-[9px] tracking-widest uppercase ${
										tab === value
											? "bg-primary/10 text-primary"
											: "text-muted-foreground hover:bg-accent"
									}`}
								>
									{value}
								</button>
							),
						)}
					</div>
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Filter loaded integrations"
						aria-label="Filter loaded provider integrations"
						className="min-w-0 flex-1 border border-border bg-input px-2.5 py-1.5 text-xs @2xl:max-w-sm"
					/>
				</div>
				{notice && (
					<div className="border-t border-status-info/20 bg-status-info/5 px-4 py-2 text-[10px] text-status-info/80">
						{notice}
					</div>
				)}
				{error && (
					<div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-[10px] text-destructive">
						{error}
					</div>
				)}
				{catalog?.issues?.map((issue) => (
					<div
						key={issue}
						className="border-t border-status-warning/20 px-4 py-2 text-[9px] text-status-warning/75"
					>
						{issue}
					</div>
				))}
			</div>

			<div className="max-h-[55vh] overflow-y-auto border border-border bg-card divide-y divide-border">
				{loading && !catalog ? (
					<div className="px-4 py-8 text-center text-xs text-muted-foreground">
						Loading provider Apps and connectors…
					</div>
				) : tab === "connectors" ? (
					filteredConnectors.length ? (
						filteredConnectors.map((connector) => (
							<ConnectorRow
								key={connector.id}
								connector={connector}
								busy={
									pendingTarget?.kind === "mcp" &&
									pendingTarget.id === connector.id
								}
								onAuthenticate={() =>
									void authenticate({ kind: "mcp", id: connector.id })
								}
							/>
						))
					) : (
						<div className="px-4 py-8 text-center text-xs text-muted-foreground">
							No connectors match this view.
						</div>
					)
				) : filteredApps.length ? (
					filteredApps.map((app) => (
						<AppRow
							key={app.id}
							app={app}
							busy={
								pendingTarget?.kind === "app" && pendingTarget.id === app.id
							}
							onAuthenticate={() =>
								void authenticate({ kind: "app", id: app.id })
							}
						/>
					))
				) : (
					<div className="px-4 py-8 text-center text-xs text-muted-foreground">
						No apps match this view.
					</div>
				)}
			</div>
			{tab === "available" && catalog?.nextCursor && (
				<button
					type="button"
					disabled={loadingMore}
					onClick={() => void load({ cursor: catalog.nextCursor ?? undefined })}
					className="w-full border border-border px-3 py-2 text-[9px] tracking-widest uppercase hover:bg-accent disabled:opacity-40"
				>
					{loadingMore ? "Loading…" : "Load more available apps"}
				</button>
			)}
		</div>
	);
}

export function ProviderAppsDialog({
	providerId,
	providerLabel,
	cwd,
	sessionId,
	onClose,
}: {
	providerId: string;
	providerLabel: string;
	cwd?: string;
	sessionId?: string;
	onClose: () => void;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
			role="dialog"
			aria-modal="true"
			aria-label={`${providerLabel} Apps and connectors`}
			onMouseDown={(event) => {
				if (event.currentTarget === event.target) onClose();
			}}
		>
			<div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto border border-border bg-background p-4 shadow-2xl">
				<div className="mb-3 flex items-center gap-3">
					<Blocks className="h-4 w-4 text-primary/70" />
					<div className="min-w-0 flex-1">
						<div className="text-sm text-foreground">Apps and Connectors</div>
						<div className="text-[9px] tracking-widest text-muted-foreground/50 uppercase">
							provider-native inventory and authentication
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close Apps and connectors"
						className="text-muted-foreground hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
				<ProviderAppsCatalog
					providerId={providerId}
					providerLabel={providerLabel}
					cwd={cwd}
					sessionId={sessionId}
				/>
			</div>
		</div>
	);
}
