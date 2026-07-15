import type { Dispatch, SetStateAction } from "react";
import type { ActiveCockpitSkill } from "#/components/cockpit/CockpitPrompt";
import type { SessionRow, ThirtyDayStats, WeeklyStats } from "#/db";
import type { useFileUpload } from "#/hooks/useFileUpload";
import type { useWs } from "#/hooks/useWs";
import { setPendingPrompt } from "#/hooks/wsChatQueueStore";
import { resetLiveStats } from "#/hooks/wsLiveStatsStore";
import * as wsStore from "#/hooks/wsStore";
import {
	type CommandDescriptor,
	resolveCommandSubmission,
} from "#/lib/commands";
import { getCurrentSessionFn } from "#/lib/serverFns/sessions";
import { getRecentSessionsFn } from "#/lib/serverFns/stats";
import { resolveSessionId } from "#/lib/sessionRouting";
import { SESSION_LABEL_LENGTH, uid } from "#/lib/utils";

type Attachment = ReturnType<
	typeof useFileUpload
>["pendingAttachments"][number];
type Send = ReturnType<typeof useWs>["send"];

export function incrementWeeklyStats(
	stats: WeeklyStats,
	dayOfWeek = new Date().getDay(),
): WeeklyStats {
	const days = [...stats.days];
	days[dayOfWeek] = (days[dayOfWeek] ?? 0) + 1;
	return { total: stats.total + 1, days };
}

export function incrementThirtyDayStats(
	stats: ThirtyDayStats,
	today = new Date().toISOString().slice(0, 10),
): ThirtyDayStats {
	const hasToday = stats.days.some((day) => day.date === today);
	return {
		total: stats.total + 1,
		days: hasToday
			? stats.days.map((day) =>
					day.date === today ? { ...day, count: day.count + 1 } : day,
				)
			: [...stats.days, { date: today, count: 1 }],
	};
}

export function prependPendingRun(
	runs: SessionRow[],
	params: { sessionId: string; text: string; model: string | null },
): SessionRow[] {
	if (runs.some((run) => run.id === params.sessionId)) return runs;
	const pending: SessionRow = {
		id: params.sessionId,
		label: params.text.slice(0, SESSION_LABEL_LENGTH).toUpperCase(),
		model: params.model,
		started_at: Math.floor(Date.now() / 1000),
		ended_at: null,
		query_count: 0,
		total_cost: 0,
		total_estimated_cost: 0,
		unpriced_query_count: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		total_turns: 0,
	};
	return [pending, ...runs].slice(0, 5);
}

type CockpitRunOptions = {
	prompt: string;
	activeSkill: ActiveCockpitSkill | null;
	commands: CommandDescriptor[];
	wsStatus: string;
	sameSession: boolean;
	attachSessionIdRef: { current: string | null };
	pendingAttachments: Attachment[];
	clearPendingAttachments: () => void;
	isRunning: boolean;
	selectedAgentPath: string;
	background: boolean;
	model: string | null | undefined;
	send: Send;
	setRunError: (error: string | null) => void;
	setPrompt: (prompt: string) => void;
	setActiveSkill: (skill: ActiveCockpitSkill | null) => void;
	setRecentRuns: Dispatch<SetStateAction<SessionRow[]>>;
	setThirtyDayStats: Dispatch<SetStateAction<ThirtyDayStats>>;
	setWeeklyStats: Dispatch<SetStateAction<WeeklyStats>>;
	navigateToRaven: (sessionId: string, agentPath?: string) => void;
};

async function resolveRunSession(options: CockpitRunOptions): Promise<string> {
	const currentId = options.sameSession ? await getCurrentSessionFn() : null;
	const mostRecentId =
		options.sameSession && !currentId
			? (await getRecentSessionsFn())[0]?.id
			: undefined;
	return resolveSessionId({
		sameSession: options.sameSession,
		currentId,
		mostRecentId,
		attachedId: options.attachSessionIdRef.current,
		newId: uid(),
	});
}

function clearComposer(options: CockpitRunOptions): void {
	options.setPrompt("");
	options.setActiveSkill(null);
}

function navigateAfterRun(
	options: CockpitRunOptions,
	sessionId: string,
	text?: string,
): void {
	if (options.background) return;
	if (text) setPendingPrompt(text);
	options.navigateToRaven(sessionId, options.selectedAgentPath || undefined);
}

function enqueueRun(
	options: CockpitRunOptions,
	params: {
		sessionId: string;
		text: string;
		skillContext?: string;
		commandAction?: "review" | "computer-use";
		attachments: Attachment[];
	},
): void {
	wsStore.enqueueChat({
		id: uid(),
		text: params.text,
		session_id: params.sessionId,
		skill_context: params.skillContext,
		command_action: params.commandAction,
		agent_cwd: options.selectedAgentPath || undefined,
		attachments: params.attachments.length > 0 ? params.attachments : undefined,
	});
	clearComposer(options);
	navigateAfterRun(options, params.sessionId);
}

function startRun(
	options: CockpitRunOptions,
	params: {
		sessionId: string;
		text: string;
		skillContext?: string;
		commandAction?: "review" | "computer-use";
		attachments: Attachment[];
	},
): void {
	if (!options.sameSession) resetLiveStats();
	options.send({
		type: "chat",
		text: params.text,
		session_id: params.sessionId,
		skill_context: params.skillContext,
		command_action: params.commandAction,
		agent_cwd: options.selectedAgentPath || undefined,
		attachments: params.attachments.length > 0 ? params.attachments : undefined,
	});
	if (!options.sameSession) {
		options.setRecentRuns((runs) =>
			prependPendingRun(runs, {
				sessionId: params.sessionId,
				text: params.text,
				model: options.model ?? null,
			}),
		);
		options.setThirtyDayStats((stats) => incrementThirtyDayStats(stats));
		options.setWeeklyStats((stats) => incrementWeeklyStats(stats));
	}
	clearComposer(options);
	navigateAfterRun(options, params.sessionId, params.text);
}

export function useCockpitRun(options: CockpitRunOptions) {
	return async (overrideText?: string): Promise<void> => {
		const typed = (overrideText ?? options.prompt).trim();
		const { text, skillContext, commandAction } = resolveCommandSubmission(
			options.activeSkill,
			typed,
			options.commands,
		);
		if (!text || options.wsStatus !== "connected") return;
		options.setRunError(null);
		let sessionId: string;
		try {
			sessionId = await resolveRunSession(options);
		} catch (error) {
			options.setRunError(
				error instanceof Error ? error.message : "Could not start run",
			);
			return;
		}
		options.attachSessionIdRef.current = null;
		const attachments = options.pendingAttachments;
		options.clearPendingAttachments();
		const params = {
			sessionId,
			text,
			skillContext,
			commandAction,
			attachments,
		};
		if (options.isRunning) enqueueRun(options, params);
		else startRun(options, params);
	};
}
