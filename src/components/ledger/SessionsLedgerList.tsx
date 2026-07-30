import {
	type LedgerPagination,
	LedgerPaginationBar,
} from "#/components/ledger/LedgerPagination";
import {
	SessionLedgerRow,
	type SessionLedgerRowProps,
} from "#/components/ledger/SessionsLedgerRow";
import type { SessionRow } from "#/db";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import type { SessionStatusEntry } from "#/server/protocol";

export type SessionsLedgerRowActions = Pick<
	SessionLedgerRowProps,
	"onDelete" | "onNavigate" | "onRename" | "onPin" | "onArchive" | "onFork"
>;

export type SessionsLedgerRowRuntime = {
	activeSessionId?: string | null;
	activeSession?: SessionRow | null;
	sessionsStatus?: SessionStatusEntry[];
	liveStats?: LiveStats;
	forkingIds?: Set<string>;
	forkProviderIds?: ReadonlySet<string>;
	isDesktop: boolean;
};

type SessionsLedgerListProps = {
	sessions: SessionRow[];
	loading: boolean;
	hasFilters: boolean;
	archived: boolean;
	onClearFilters?: () => void;
	onSearchChange?: (query: string) => void;
	rowActions: SessionsLedgerRowActions;
	rowRuntime: SessionsLedgerRowRuntime;
	pagination: LedgerPagination;
};

type SessionsLedgerContentProps = Omit<SessionsLedgerListProps, "pagination">;

function SessionsLedgerEmptyState({
	hasFilters,
	archived,
	onClearFilters,
	onSearchChange,
}: Pick<
	SessionsLedgerListProps,
	"hasFilters" | "archived" | "onClearFilters" | "onSearchChange"
>) {
	if (hasFilters) {
		return (
			<>
				no sessions match the current filters ·{" "}
				<button
					type="button"
					onClick={() =>
						onClearFilters ? onClearFilters() : onSearchChange?.("")
					}
					className="text-primary hover:text-primary/80 underline underline-offset-2 normal-case tracking-normal"
				>
					clear filters
				</button>
			</>
		);
	}
	return archived ? "no archived sessions" : "no sessions";
}

function statusBySessionId(
	sessionsStatus: SessionStatusEntry[] | undefined,
): Map<string, SessionStatusEntry> {
	const result = new Map<string, SessionStatusEntry>();
	for (const status of sessionsStatus ?? []) {
		if (status.db_session_id && !result.has(status.db_session_id)) {
			result.set(status.db_session_id, status);
		}
	}
	return result;
}

function SessionsLedgerRows({
	sessions,
	archived,
	rowActions,
	rowRuntime,
}: Pick<
	SessionsLedgerListProps,
	"sessions" | "archived" | "rowActions" | "rowRuntime"
>) {
	const statuses = statusBySessionId(rowRuntime.sessionsStatus);
	return sessions.map((session) => (
		<SessionLedgerRow
			key={session.id}
			session={session}
			usageSession={
				rowRuntime.activeSessionId === session.id
					? (rowRuntime.activeSession ?? undefined)
					: undefined
			}
			{...rowActions}
			archived={archived}
			isForking={rowRuntime.forkingIds?.has(session.id) ?? false}
			isActive={
				rowRuntime.activeSessionId != null &&
				session.id === rowRuntime.activeSessionId
			}
			poolSession={statuses.get(session.id)}
			liveStats={rowRuntime.liveStats}
			isDesktop={rowRuntime.isDesktop}
			forkProviderIds={rowRuntime.forkProviderIds}
		/>
	));
}

function SessionsLedgerContent(props: SessionsLedgerContentProps) {
	if (props.loading) {
		return (
			<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
				loading…
			</div>
		);
	}
	if (props.sessions.length === 0) {
		return (
			<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
				<SessionsLedgerEmptyState
					hasFilters={props.hasFilters}
					archived={props.archived}
					onClearFilters={props.onClearFilters}
					onSearchChange={props.onSearchChange}
				/>
			</div>
		);
	}
	return (
		<SessionsLedgerRows
			sessions={props.sessions}
			archived={props.archived}
			rowActions={props.rowActions}
			rowRuntime={props.rowRuntime}
		/>
	);
}

export function SessionsLedgerList(props: SessionsLedgerListProps) {
	const { pagination, ...contentProps } = props;
	return (
		<>
			<SessionsLedgerContent {...contentProps} />
			{pagination.totalPages > 1 && (
				<LedgerPaginationBar pagination={pagination} loading={props.loading} />
			)}
		</>
	);
}
