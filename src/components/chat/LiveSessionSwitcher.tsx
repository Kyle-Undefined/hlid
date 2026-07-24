import { Scroll } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import {
	deriveLiveSessionSwitcherRows,
	type LiveSessionState,
	type LiveSessionSwitcherRow,
	liveSessionContext,
	liveSessionToggleTone,
} from "#/lib/liveSessionSwitcher";
import { displayHotkey, matchesHotkey } from "#/lib/voiceHotkey";

const MOBILE_HISTORY_KEY = "__hlidLiveSessionSwitcher";

type LiveSessionSwitcherProps = {
	children: ReactNode;
	currentSessionId: string;
	hotkey: string;
	voiceHotkey?: string;
	onSelectSession: (sessionId: string, replace: boolean) => void;
	onOpenLedger: (replace: boolean) => void;
};

function toneClass(tone: ReturnType<typeof liveSessionToggleTone>): string {
	if (tone === "waiting") return "text-amber-400";
	if (tone === "working") return "text-primary";
	return "text-muted-foreground/55";
}

function stateClass(state: LiveSessionState): string {
	if (state === "waiting") return "text-amber-400";
	if (state === "working") return "text-primary";
	return "text-muted-foreground/55";
}

function stateLabel(state: LiveSessionState): string {
	if (state === "waiting") return "Waiting";
	if (state === "working") return "Working";
	return "Ready";
}

function toggleLabel(
	open: boolean,
	count: number,
	tone: ReturnType<typeof liveSessionToggleTone>,
): string {
	const state =
		tone === "waiting"
			? "attention needed"
			: tone === "working"
				? "work in progress"
				: tone === "ready"
					? "all ready"
					: "none live";
	return `${open ? "Close" : "Open"} live sessions, ${count} total, ${state}`;
}

type RetainedRow = LiveSessionSwitcherRow & { closed: boolean };

type LiveSessionSwitcherContextValue = {
	count: number;
	hotkey: string;
	open: boolean;
	toggle: () => void;
	tone: ReturnType<typeof liveSessionToggleTone>;
};

const LiveSessionSwitcherContext =
	createContext<LiveSessionSwitcherContextValue | null>(null);

export function LiveSessionToggle() {
	const switcher = useContext(LiveSessionSwitcherContext);
	if (!switcher) {
		throw new Error("LiveSessionToggle must be inside LiveSessionSwitcher");
	}
	if (switcher.open) {
		return <span aria-hidden="true" className="h-11 w-10 shrink-0" />;
	}

	return (
		<button
			type="button"
			onClick={switcher.toggle}
			aria-expanded="false"
			aria-controls="raven-live-session-drawer"
			aria-label={toggleLabel(false, switcher.count, switcher.tone)}
			title={
				switcher.hotkey
					? `Live sessions (${displayHotkey(switcher.hotkey)})`
					: "Live sessions"
			}
			className={`relative flex shrink-0 select-none items-center px-4 py-3 text-sm transition-colors hover:text-foreground ${toneClass(switcher.tone)}`}
		>
			<span aria-hidden="true">›</span>
			<span className="absolute right-1 top-1 min-w-3 rounded-full bg-background px-0.5 text-center font-mono text-[7px] leading-3">
				{switcher.count > 99 ? "99+" : switcher.count}
			</span>
		</button>
	);
}

function LiveSessionDrawer({
	rows,
	currentSessionId,
	onSelect,
	onClose,
	onOpenLedger,
}: {
	rows: LiveSessionSwitcherRow[];
	currentSessionId: string;
	onSelect: (sessionId: string) => void;
	onClose: () => void;
	onOpenLedger: () => void;
}) {
	const orderRef = useRef(rows.map((row) => row.session.session_id));
	const retainedRef = useRef<Map<string, RetainedRow>>(
		new Map(
			rows.map((row) => [row.session.session_id, { ...row, closed: false }]),
		),
	);
	const liveIds = new Set(rows.map((row) => row.session.session_id));
	for (const row of rows) {
		if (!retainedRef.current.has(row.session.session_id)) {
			orderRef.current.push(row.session.session_id);
		}
		retainedRef.current.set(row.session.session_id, {
			...row,
			closed: false,
		});
	}
	for (const id of orderRef.current) {
		const retained = retainedRef.current.get(id);
		if (retained && !liveIds.has(id)) {
			retainedRef.current.set(id, { ...retained, closed: true });
		}
	}
	const retainedRows = orderRef.current
		.map((id) => retainedRef.current.get(id))
		.filter((row): row is RetainedRow => Boolean(row));

	return (
		<>
			<button
				type="button"
				onClick={onClose}
				aria-label="Dismiss live sessions"
				className="absolute inset-0 z-30 bg-black/20 md:bg-black/10"
			/>
			<aside
				id="raven-live-session-drawer"
				role="dialog"
				aria-modal="true"
				aria-label="Live sessions"
				className="absolute inset-y-0 left-0 z-40 flex w-[88vw] max-w-80 flex-col overflow-hidden border-r border-border bg-popover shadow-2xl md:w-80"
			>
				<header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
					<div className="min-w-0 flex-1">
						<div className="text-[10px] tracking-widest text-foreground/85 uppercase">
							Live sessions
						</div>
						<div className="font-mono text-[9px] text-muted-foreground/55">
							{rows.length} process-backed
						</div>
					</div>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					{retainedRows.length === 0 ? (
						<div className="px-4 py-10 text-center text-[10px] tracking-widest text-muted-foreground/45 uppercase">
							No live sessions
						</div>
					) : (
						retainedRows.map((row) => {
							const { session } = row;
							const label = session.lastLabel?.trim() || session.agent_name;
							const context = liveSessionContext(session);
							const current =
								currentSessionId === row.dbSessionId ||
								currentSessionId === session.session_id;
							return (
								<button
									key={session.session_id}
									type="button"
									disabled={row.closed}
									onClick={() => onSelect(row.dbSessionId)}
									aria-label={`Open ${label} session`}
									aria-current={current ? "page" : undefined}
									className="flex min-h-16 w-full items-center gap-3 border-b border-border/45 px-4 py-2.5 text-left transition-colors hover:bg-accent/35 disabled:cursor-default disabled:opacity-45"
								>
									<span
										className={`h-1.5 w-1.5 shrink-0 rounded-full ${
											row.closed
												? "bg-muted-foreground/30"
												: row.state === "waiting"
													? "bg-amber-400"
													: row.state === "working"
														? "bg-primary"
														: "bg-muted-foreground/35"
										}`}
									/>
									<span className="min-w-0 flex-1">
										<PrivacyMask className="block min-w-0 truncate text-[11px] font-medium text-foreground/90">
											{label}
										</PrivacyMask>
										{context && (
											<span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground/50">
												{context}
											</span>
										)}
									</span>
									{current && (
										<span className="shrink-0 text-[8px] tracking-widest text-primary/70 uppercase">
											Current
										</span>
									)}
									<span
										className={`w-14 shrink-0 text-right font-mono text-[8px] tracking-widest uppercase ${
											row.closed
												? "text-muted-foreground/35"
												: stateClass(row.state)
										}`}
									>
										{row.closed ? "Closed" : stateLabel(row.state)}
									</span>
								</button>
							);
						})
					)}
				</div>

				<footer className="flex shrink-0 items-stretch border-t border-border pb-[env(safe-area-inset-bottom)]">
					<span aria-hidden="true" className="w-10 shrink-0" />
					<button
						type="button"
						onClick={onClose}
						aria-label={toggleLabel(
							true,
							rows.length,
							liveSessionToggleTone(rows),
						)}
						className={`flex min-h-12 w-11 shrink-0 items-center justify-center text-lg transition-colors hover:text-foreground ${toneClass(liveSessionToggleTone(rows))}`}
					>
						<span aria-hidden="true">‹</span>
					</button>
					<button
						type="button"
						onClick={onOpenLedger}
						className="flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 text-[9px] tracking-widest text-muted-foreground/65 uppercase transition-colors hover:bg-accent/30 hover:text-foreground"
					>
						<Scroll className="h-3.5 w-3.5" />
						Open Ledger
					</button>
				</footer>
			</aside>
		</>
	);
}

export function LiveSessionSwitcher({
	children,
	currentSessionId,
	hotkey,
	voiceHotkey = "",
	onSelectSession,
	onOpenLedger,
}: LiveSessionSwitcherProps) {
	const sessions = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => [],
	);
	const rows = deriveLiveSessionSwitcherRows(sessions);
	const tone = liveSessionToggleTone(rows);
	const isDesktop = useIsDesktop();
	const effectiveHotkey = hotkey !== voiceHotkey ? hotkey : "";
	const [open, setOpen] = useState(false);
	const mobileHistoryPushedRef = useRef(false);

	function clearMobileHistoryMarker(): void {
		if (!mobileHistoryPushedRef.current) return;
		const current = window.history.state as Record<string, unknown> | null;
		if (current?.[MOBILE_HISTORY_KEY]) {
			const next = { ...current };
			delete next[MOBILE_HISTORY_KEY];
			window.history.replaceState(next, "");
		}
		mobileHistoryPushedRef.current = false;
	}

	function openDrawer(): void {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
		if (!isDesktop) {
			window.history.pushState(
				{ ...(window.history.state ?? {}), [MOBILE_HISTORY_KEY]: true },
				"",
			);
			mobileHistoryPushedRef.current = true;
		}
		setOpen(true);
	}

	function closeDrawer(): void {
		setOpen(false);
		if (mobileHistoryPushedRef.current) {
			mobileHistoryPushedRef.current = false;
			window.history.back();
		}
	}

	function leaveDrawer(action: (replace: boolean) => void): void {
		const replace = !isDesktop && mobileHistoryPushedRef.current;
		if (replace) clearMobileHistoryMarker();
		setOpen(false);
		action(replace);
	}

	useEffect(() => {
		if (!open) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") closeDrawer();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	useEffect(() => {
		if (!isDesktop || !effectiveHotkey) return;
		function onHotkey(event: KeyboardEvent) {
			if (event.repeat || !matchesHotkey(event, effectiveHotkey)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (open) closeDrawer();
			else openDrawer();
		}
		window.addEventListener("keydown", onHotkey, { capture: true });
		return () =>
			window.removeEventListener("keydown", onHotkey, { capture: true });
	});

	useEffect(() => {
		if (!open || isDesktop) return;
		function onPopState() {
			if (!mobileHistoryPushedRef.current) return;
			mobileHistoryPushedRef.current = false;
			setOpen(false);
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [isDesktop, open]);

	useEffect(
		() => () => {
			if (!mobileHistoryPushedRef.current) return;
			const current = window.history.state as Record<string, unknown> | null;
			if (current?.[MOBILE_HISTORY_KEY]) {
				const next = { ...current };
				delete next[MOBILE_HISTORY_KEY];
				window.history.replaceState(next, "");
			}
			mobileHistoryPushedRef.current = false;
		},
		[],
	);

	return (
		<LiveSessionSwitcherContext.Provider
			value={{
				count: rows.length,
				hotkey: effectiveHotkey,
				open,
				toggle: open ? closeDrawer : openDrawer,
				tone,
			}}
		>
			<div className="relative h-full min-h-0 flex flex-col overflow-hidden">
				{children}
				{open && (
					<LiveSessionDrawer
						rows={rows}
						currentSessionId={currentSessionId}
						onClose={closeDrawer}
						onSelect={(sessionId) =>
							leaveDrawer((replace) => onSelectSession(sessionId, replace))
						}
						onOpenLedger={() => leaveDrawer((replace) => onOpenLedger(replace))}
					/>
				)}
			</div>
		</LiveSessionSwitcherContext.Provider>
	);
}
