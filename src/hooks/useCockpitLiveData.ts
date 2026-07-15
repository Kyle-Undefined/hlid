import { useCallback, useEffect, useRef, useState } from "react";
import {
	type McpServerEntry,
	mapMcpServer,
} from "#/components/cockpit/McpPanel";
import type { AggStats, SessionRow, ThirtyDayStats, WeeklyStats } from "#/db";
import {
	incrementThirtyDayStats,
	incrementWeeklyStats,
} from "#/hooks/useCockpitRun";
import { useWs } from "#/hooks/useWs";
import { getPendingSessionToday } from "#/hooks/wsLiveStatsStore";
import {
	getSessionsStatus,
	subscribeSessionsStatus,
} from "#/hooks/wsSessionStatusStore";
import { getActiveSessionRowFn } from "#/lib/serverFns/sessions";
import {
	getCockpitStatsFn,
	getRecentSessionsFn,
	getThirtyDayStatsFn,
	getWeeklyStatsFn,
} from "#/lib/serverFns/stats";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

type InitialCockpitLiveData = {
	recentSessions: SessionRow[];
	agg: AggStats;
	weeklyStats: WeeklyStats;
	thirtyDayStats: ThirtyDayStats;
	activeSession: SessionRow | null;
	mcpServers: McpServerEntry[];
};

function initialWeeklyStats(stats: WeeklyStats): WeeklyStats {
	return getPendingSessionToday() ? incrementWeeklyStats(stats) : stats;
}

function initialThirtyDayStats(stats: ThirtyDayStats): ThirtyDayStats {
	return getPendingSessionToday() ? incrementThirtyDayStats(stats) : stats;
}

export function useCockpitLiveData(
	initial: InitialCockpitLiveData,
	commandAgentCwd?: string,
) {
	const [recentRuns, setRecentRuns] = useState(initial.recentSessions);
	const [agg, setAgg] = useState(initial.agg);
	const [weeklyStats, setWeeklyStats] = useState(() =>
		initialWeeklyStats(initial.weeklyStats),
	);
	const [thirtyDayStats, setThirtyDayStats] = useState(() =>
		initialThirtyDayStats(initial.thirtyDayStats),
	);
	const [liveActiveSession, setLiveActiveSession] = useState(
		initial.activeSession,
	);
	const [mcpServers, setMcpServers] = useState(initial.mcpServers);
	const [sdkSlashCommands, setSdkSlashCommands] = useState<
		Array<{
			name: string;
			description: string;
			argumentHint: string;
			aliases?: string[];
			action?: "review";
		}>
	>([]);
	const [runError, setRunError] = useState<string | null>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const refreshGenerationRef = useRef(0);
	const recentRefreshGenerationRef = useRef(0);
	const liveSessionIdsRef = useRef(new Set<string>());

	const refreshRecentRuns = useCallback((): void => {
		const generation = ++recentRefreshGenerationRef.current;
		void getRecentSessionsFn()
			.then((runs) => {
				if (generation === recentRefreshGenerationRef.current)
					setRecentRuns(runs);
			})
			.catch(() => {});
	}, []);

	const ws = useWs((message: ServerMessage) => {
		if (message.type === "done") {
			setRunError(null);
			const generation = ++refreshGenerationRef.current;
			const recentGeneration = ++recentRefreshGenerationRef.current;
			void getRecentSessionsFn()
				.then((runs) => {
					if (recentGeneration === recentRefreshGenerationRef.current)
						setRecentRuns(runs);
				})
				.catch(() => {});
			void getCockpitStatsFn()
				.then((data) => {
					if (generation === refreshGenerationRef.current) setAgg(data.agg);
				})
				.catch(() => {});
			void getWeeklyStatsFn()
				.then((stats) => {
					if (generation === refreshGenerationRef.current)
						setWeeklyStats(stats);
				})
				.catch(() => {});
			void getThirtyDayStatsFn()
				.then((stats) => {
					if (generation === refreshGenerationRef.current)
						setThirtyDayStats(stats);
				})
				.catch(() => {});
			void getActiveSessionRowFn()
				.then((session) => {
					if (generation === refreshGenerationRef.current)
						setLiveActiveSession(session);
				})
				.catch(() => {});
		}
		if (message.type === "error") setRunError(message.message);
		if (message.type === "rate_limit") setRateLimit(message);
		if (message.type === "mcp_status") {
			if ((message.agent_cwd ?? "") !== (commandAgentCwd ?? "")) return;
			setMcpServers(
				message.servers.map((server) =>
					mapMcpServer({
						...server,
						providerId: server.provider_id ?? message.provider_id,
					}),
				),
			);
		}
		if (message.type === "slash_commands") {
			if ((message.agent_cwd ?? "") !== (commandAgentCwd ?? "")) return;
			setSdkSlashCommands(message.commands);
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: agent context changes invalidate the scoped command snapshot
	useEffect(() => {
		setSdkSlashCommands([]);
	}, [commandAgentCwd]);

	useEffect(() => {
		ws.send({
			type: "sync_mcp_list",
			inventory: true,
			...(commandAgentCwd ? { agent_cwd: commandAgentCwd } : {}),
		});
		ws.send({
			type: "probe_slash_commands",
			...(commandAgentCwd ? { agent_cwd: commandAgentCwd } : {}),
		});
	}, [ws.send, commandAgentCwd]);

	useEffect(() => {
		let active = true;
		const refreshForNewLiveSession = () => {
			const nextIds = new Set(
				getSessionsStatus()
					.map((session) => session.db_session_id)
					.filter((id): id is string => Boolean(id)),
			);
			const hasNewSession = [...nextIds].some(
				(id) => !liveSessionIdsRef.current.has(id),
			);
			liveSessionIdsRef.current = nextIds;
			if (active && hasNewSession) refreshRecentRuns();
		};
		refreshForNewLiveSession();
		const unsubscribeSessions = subscribeSessionsStatus(
			refreshForNewLiveSession,
		);
		void getActiveSessionRowFn()
			.then((session) => {
				if (active) setLiveActiveSession(session);
			})
			.catch(() => {});
		return () => {
			active = false;
			unsubscribeSessions();
			refreshGenerationRef.current++;
			recentRefreshGenerationRef.current++;
		};
	}, [refreshRecentRuns]);

	return {
		...ws,
		recentRuns,
		setRecentRuns,
		agg,
		weeklyStats,
		setWeeklyStats,
		thirtyDayStats,
		setThirtyDayStats,
		liveActiveSession,
		mcpServers,
		sdkSlashCommands,
		runError,
		setRunError,
		rateLimit,
	};
}
