import { useMemo } from "react";
import {
	SessionsLedgerControls,
	type SessionsLedgerFilterControls,
	type SessionsLedgerPageControls,
	type SessionsLedgerSecondaryActions,
} from "#/components/ledger/SessionsLedgerControls";
import {
	SessionsLedgerList,
	type SessionsLedgerRowActions,
	type SessionsLedgerRowRuntime,
} from "#/components/ledger/SessionsLedgerList";

// fallow-ignore-next-line unused-export -- preserve the existing helper import surface for tests and downstream callers.
export { sessionDisplayUsage } from "#/components/ledger/SessionsLedgerRow";

import type { SessionCleanupReceipt, SessionRow } from "#/db";
import { useIsDesktop } from "#/hooks/useIsDesktop";
import type { LiveStats } from "#/hooks/wsLiveStatsStore";
import type { LedgerAgentOption, SessionSortKey } from "#/lib/ledgerState";
import type { SessionStatusEntry } from "#/server/protocol";

type SessionsLedgerProps = {
	data: { sessions: SessionRow[]; total: number };
	page: number;
	pageSize: number;
	pageSizeOptions: readonly number[];
	totalPages: number;
	loading: boolean;
	onPageChange: (page: number) => void;
	onPageSizeChange: (size: number) => void;
	onDelete: (id: string) => void;
	onRename: (id: string, label: string) => void;
	onPin: (id: string, pinned: boolean) => void;
	onArchive: (id: string, archived: boolean) => void;
	onFork: (id: string) => void;
	forkingIds?: Set<string>;
	onNavigate: (id: string) => void;
	onCleanup: (days: number, previewId?: string) => void;
	onPreviewCleanup?: (days: number) => Promise<SessionCleanupReceipt>;
	activeSessionId?: string | null;
	activeSession?: SessionRow | null;
	sessionsStatus?: SessionStatusEntry[];
	liveStats?: LiveStats;
	search?: string;
	onSearchChange?: (query: string) => void;
	agentFilter?: string;
	agentOptions?: LedgerAgentOption[];
	onAgentFilterChange?: (agent: string) => void;
	modelFilter?: string;
	modelOptions?: string[];
	onModelFilterChange?: (model: string) => void;
	onClearFilters?: () => void;
	sort?: SessionSortKey;
	onSortChange?: (sort: SessionSortKey) => void;
	/** Unix seconds of the oldest session overall; drives cleanup options. */
	oldestStartedAt?: number | null;
	/** Serialized loader time keeps cleanup options identical during hydration. */
	cleanupReferenceTime?: number;
	onExport?: (format: "csv" | "json") => void;
	onImportClaude?: () => void;
	claudeImportStatus?: string | null;
	claudeImportBusy?: boolean;
	forkProviderIds?: ReadonlySet<string>;
	archived?: boolean;
	onArchivedChange?: (archived: boolean) => void;
};

function runningSessionIds(
	sessionsStatus: SessionStatusEntry[] | undefined,
): Set<string> {
	return new Set(
		(sessionsStatus ?? []).flatMap((session) =>
			session.state === "running" && session.db_session_id
				? [session.db_session_id]
				: [],
		),
	);
}

function prioritizedSessions(
	sessions: SessionRow[],
	sort: SessionSortKey,
	runningIds: ReadonlySet<string>,
): SessionRow[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => {
			const pinnedOrder =
				Number(right.session.pinned === 1) - Number(left.session.pinned === 1);
			const runningOrder =
				sort === "recent"
					? Number(runningIds.has(right.session.id)) -
						Number(runningIds.has(left.session.id))
					: 0;
			return pinnedOrder || runningOrder || left.index - right.index;
		})
		.map(({ session }) => session);
}

export function SessionsLedger(props: SessionsLedgerProps) {
	const {
		data,
		page,
		pageSize,
		pageSizeOptions,
		totalPages,
		loading,
		onPageChange,
		onPageSizeChange,
		onDelete,
		onRename,
		onPin,
		onArchive,
		onFork,
		forkingIds,
		onNavigate,
		onCleanup,
		onPreviewCleanup,
		activeSessionId,
		activeSession,
		sessionsStatus,
		liveStats,
		search = "",
		onSearchChange,
		agentFilter = "",
		agentOptions = [],
		onAgentFilterChange,
		modelFilter = "",
		modelOptions = [],
		onModelFilterChange,
		onClearFilters,
		sort = "recent",
		onSortChange,
		oldestStartedAt = null,
		cleanupReferenceTime = 0,
		onExport,
		onImportClaude,
		claudeImportStatus,
		claudeImportBusy = false,
		forkProviderIds,
		archived = false,
		onArchivedChange,
	} = props;
	const isDesktop = useIsDesktop();
	const runningIds = useMemo(
		() => runningSessionIds(sessionsStatus),
		[sessionsStatus],
	);
	const displayedSessions = useMemo(
		() => prioritizedSessions(data.sessions, sort, runningIds),
		[data.sessions, sort, runningIds],
	);
	const filters: SessionsLedgerFilterControls = {
		search,
		onSearchChange,
		agentFilter,
		agentOptions,
		onAgentFilterChange,
		modelFilter,
		modelOptions,
		onModelFilterChange,
		sort,
		onSortChange,
	};
	const paging: SessionsLedgerPageControls = {
		pageSize,
		pageSizeOptions,
		onPageSizeChange,
	};
	const secondaryActions: SessionsLedgerSecondaryActions = {
		archived,
		oldestStartedAt,
		cleanupReferenceTime,
		onCleanup,
		onPreviewCleanup,
		onExport,
		onImportClaude,
		claudeImportStatus,
		claudeImportBusy,
	};
	const rowActions: SessionsLedgerRowActions = {
		onDelete,
		onNavigate,
		onRename,
		onPin,
		onArchive,
		onFork,
	};
	const rowRuntime: SessionsLedgerRowRuntime = {
		activeSessionId,
		activeSession,
		sessionsStatus,
		liveStats,
		forkingIds,
		forkProviderIds,
		isDesktop,
	};

	return (
		<div className="border border-border bg-card">
			<SessionsLedgerControls
				total={data.total}
				archived={archived}
				onArchivedChange={onArchivedChange}
				filters={filters}
				paging={paging}
				secondaryActions={secondaryActions}
			/>
			<SessionsLedgerList
				sessions={displayedSessions}
				loading={loading}
				hasFilters={Boolean(search || agentFilter || modelFilter)}
				archived={archived}
				onClearFilters={onClearFilters}
				onSearchChange={onSearchChange}
				rowActions={rowActions}
				rowRuntime={rowRuntime}
				pagination={{
					page,
					totalPages,
					onPageChange,
				}}
			/>
		</div>
	);
}
