import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
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

const EMPTY_SESSIONS: ReturnType<typeof getSessionsStatus> = [];

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

function mergeProviderMcpServers(
	previous: McpServerEntry[],
	incoming: McpServerEntry[],
	providerId: string,
): McpServerEntry[] {
	const incomingNames = new Set(incoming.map((server) => server.name));
	return [
		...previous.filter(
			(server) =>
				server.providerId !== providerId &&
				!(server.providerId === undefined && incomingNames.has(server.name)),
		),
		...incoming,
	];
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
			action?: "review" | "computer-use";
		}>
	>([]);
	const [sdkSlashCommandProviderId, setSdkSlashCommandProviderId] = useState<
		string | null
	>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const sessionsStatus = useSyncExternalStore(
		subscribeSessionsStatus,
		getSessionsStatus,
		() => EMPTY_SESSIONS,
	);
	const refreshGenerationRef = useRef(0);
	const recentRefreshGenerationRef = useRef(0);
	const activeRefreshGenerationRef = useRef(0);
	const liveSessionIdsRef = useRef(new Set<string>());

	// Route invalidation is how changes from other browser tabs and other live
	// sessions arrive. Mirror refreshed loader snapshots into the hook's local
	// view without remounting the composer or disturbing an in-progress prompt.
	useEffect(
		() => setRecentRuns(initial.recentSessions),
		[initial.recentSessions],
	);
	useEffect(() => setAgg(initial.agg), [initial.agg]);
	useEffect(() => setWeeklyStats(initial.weeklyStats), [initial.weeklyStats]);
	useEffect(
		() => setThirtyDayStats(initial.thirtyDayStats),
		[initial.thirtyDayStats],
	);
	useEffect(
		() => setLiveActiveSession(initial.activeSession),
		[initial.activeSession],
	);
	useEffect(() => {
		// Optional loader recovery is a vault-provider fallback, while the WS
		// inventory is cross-provider. It may seed an empty view, but must never
		// replace an aggregate inventory that has already arrived.
		setMcpServers((previous) =>
			previous.length > 0 ? previous : initial.mcpServers,
		);
	}, [initial.mcpServers]);

	const refreshRecentRuns = useCallback((): void => {
		const generation = ++recentRefreshGenerationRef.current;
		void getRecentSessionsFn()
			.then((runs) => {
				if (generation === recentRefreshGenerationRef.current)
					setRecentRuns(runs);
			})
			.catch(() => {});
	}, []);
	const refreshActiveSession = useCallback((): void => {
		const generation = ++activeRefreshGenerationRef.current;
		void getActiveSessionRowFn()
			.then((session) => {
				if (generation === activeRefreshGenerationRef.current)
					setLiveActiveSession(session);
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
			refreshActiveSession();
		}
		if (message.type === "error") setRunError(message.message);
		if (message.type === "rate_limit") setRateLimit(message);
		if (message.type === "mcp_status") {
			if ((message.agent_cwd ?? "") !== (commandAgentCwd ?? "")) return;
			const incoming = message.servers.map((server) =>
				mapMcpServer({
					...server,
					providerId: server.provider_id ?? message.provider_id,
				}),
			);
			setMcpServers((previous) =>
				message.inventory || !message.provider_id
					? incoming
					: mergeProviderMcpServers(previous, incoming, message.provider_id),
			);
		}
		if (message.type === "slash_commands") {
			if ((message.agent_cwd ?? "") !== (commandAgentCwd ?? "")) return;
			setSdkSlashCommands(message.commands);
			setSdkSlashCommandProviderId(message.provider_id);
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: agent context changes invalidate the scoped command snapshot
	useEffect(() => {
		setSdkSlashCommands([]);
		setSdkSlashCommandProviderId(null);
	}, [commandAgentCwd]);

	useEffect(() => {
		if (ws.wsStatus !== "connected") return;
		ws.send({
			type: "sync_mcp_list",
			inventory: true,
			...(commandAgentCwd ? { agent_cwd: commandAgentCwd } : {}),
		});
		ws.send({
			type: "probe_slash_commands",
			...(commandAgentCwd ? { agent_cwd: commandAgentCwd } : {}),
		});
	}, [ws.send, ws.wsStatus, commandAgentCwd]);

	useEffect(() => {
		const nextIds = new Set(
			sessionsStatus
				.map((session) => session.db_session_id)
				.filter((id): id is string => Boolean(id)),
		);
		const hasNewSession = [...nextIds].some(
			(id) => !liveSessionIdsRef.current.has(id),
		);
		liveSessionIdsRef.current = nextIds;
		if (hasNewSession) {
			refreshRecentRuns();
			refreshActiveSession();
		}
	}, [sessionsStatus, refreshRecentRuns, refreshActiveSession]);

	useEffect(() => {
		refreshActiveSession();
		return () => {
			refreshGenerationRef.current++;
			recentRefreshGenerationRef.current++;
			activeRefreshGenerationRef.current++;
		};
	}, [refreshActiveSession]);

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
		sdkSlashCommandProviderId,
		runError,
		setRunError,
		rateLimit,
		sessionsStatus,
	};
}
