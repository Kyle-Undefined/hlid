import { useEffect, useRef, useState } from "react";
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
import * as wsStore from "#/hooks/wsStore";
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
	return wsStore.getPendingSessionToday() ? incrementWeeklyStats(stats) : stats;
}

function initialThirtyDayStats(stats: ThirtyDayStats): ThirtyDayStats {
	return wsStore.getPendingSessionToday()
		? incrementThirtyDayStats(stats)
		: stats;
}

export function useCockpitLiveData(initial: InitialCockpitLiveData) {
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
		}>
	>([]);
	const [runError, setRunError] = useState<string | null>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const refreshGenerationRef = useRef(0);

	const ws = useWs((message: ServerMessage) => {
		if (message.type === "done") {
			setRunError(null);
			const generation = ++refreshGenerationRef.current;
			void getRecentSessionsFn()
				.then((runs) => {
					if (generation === refreshGenerationRef.current) setRecentRuns(runs);
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
			setMcpServers(message.servers.map(mapMcpServer));
		}
		if (message.type === "slash_commands") {
			setSdkSlashCommands(message.commands);
		}
	});

	useEffect(() => {
		ws.send({ type: "sync_mcp_list" });
		ws.send({ type: "probe_slash_commands" });
	}, [ws.send]);

	useEffect(() => {
		let active = true;
		void getActiveSessionRowFn()
			.then((session) => {
				if (active) setLiveActiveSession(session);
			})
			.catch(() => {});
		return () => {
			active = false;
			refreshGenerationRef.current++;
		};
	}, []);

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
