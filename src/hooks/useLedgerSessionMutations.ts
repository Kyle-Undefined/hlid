import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionRow } from "#/db";
import { filterOptimisticIds, filterOptimisticLabels } from "#/lib/ledgerState";

type SessionPage = {
	sessions: SessionRow[];
	total: number;
	agent_cwds?: string[];
	models?: string[];
};

type LedgerMutationDependencies = {
	deleteSession(id: string): Promise<void>;
	renameSession(id: string, label: string): Promise<void>;
	cleanupSessions(days: number): Promise<void>;
	navigateToPage(page: number): void;
};

export function useLedgerSessionMutations({
	page,
	sessionPage,
	dependencies,
}: {
	page: number;
	sessionPage: SessionPage;
	dependencies: LedgerMutationDependencies;
}) {
	const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
	const [renamedLabels, setRenamedLabels] = useState<Map<string, string>>(
		new Map(),
	);
	const [mutationError, setMutationError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: page identity resets optimistic route state
	useEffect(() => {
		setDeletedIds(new Set());
		setRenamedLabels(new Map());
		setMutationError(null);
	}, [page]);

	const sessionsData = useMemo(
		() => ({
			...sessionPage,
			sessions: sessionPage.sessions
				.filter((session) => !deletedIds.has(session.id))
				.map((session) =>
					renamedLabels.has(session.id)
						? {
								...session,
								label: renamedLabels.get(session.id) as string,
							}
						: session,
				),
			total: Math.max(0, sessionPage.total - deletedIds.size),
		}),
		[sessionPage, deletedIds, renamedLabels],
	);

	const reconcile = useCallback((fresh: SessionPage) => {
		const freshIds = new Set(fresh.sessions.map((session) => session.id));
		setDeletedIds((previous) => filterOptimisticIds(previous, freshIds));
		setRenamedLabels((previous) => filterOptimisticLabels(previous, freshIds));
	}, []);

	async function deleteSession(id: string) {
		setMutationError(null);
		const wasLastOnPage = sessionsData.sessions.length <= 1;
		setDeletedIds((previous) => new Set(previous).add(id));
		try {
			await dependencies.deleteSession(id);
			if (wasLastOnPage && page > 1) dependencies.navigateToPage(page - 1);
		} catch (error) {
			setDeletedIds((previous) => {
				const next = new Set(previous);
				next.delete(id);
				return next;
			});
			setMutationError(
				error instanceof Error ? error.message : "Failed to delete session",
			);
		}
	}

	async function renameSession(id: string, label: string) {
		setMutationError(null);
		setRenamedLabels((previous) => new Map(previous).set(id, label));
		try {
			await dependencies.renameSession(id, label);
		} catch (error) {
			setRenamedLabels((previous) => {
				const next = new Map(previous);
				next.delete(id);
				return next;
			});
			setMutationError(
				error instanceof Error ? error.message : "Failed to rename session",
			);
		}
	}

	async function cleanupSessions(days: number) {
		setMutationError(null);
		try {
			await dependencies.cleanupSessions(days);
			dependencies.navigateToPage(1);
		} catch (error) {
			setMutationError(
				error instanceof Error ? error.message : "Failed to clean up sessions",
			);
		}
	}

	return {
		sessionsData,
		mutationError,
		reconcile,
		deleteSession,
		renameSession,
		cleanupSessions,
	};
}
