import type { ProviderBackgroundActivity } from "../server/agentProvider";
import { getDb } from "./schema";

const MAX_PERSISTED_ACTIVITIES = 50;
const MAX_COMMAND_CHARS = 4_096;
const MAX_DESCRIPTION_CHARS = 4_096;
const MAX_CWD_CHARS = 4_096;
const MAX_OUTPUT_CHARS = 8_192;

type ProviderBackgroundActivityRow = {
	provider_id: string;
	provider_session_id: string;
	activity_id: string;
	process_id: string | null;
	kind: ProviderBackgroundActivity["kind"];
	status: ProviderBackgroundActivity["status"];
	command: string | null;
	description: string | null;
	cwd: string | null;
	recent_output: string | null;
	os_pid: number | null;
	cpu_percent: number | null;
	rss_kb: number | null;
	started_at_ms: number;
	updated_at_ms: number;
	ended_at_ms: number | null;
	can_stop: number;
	can_terminate: number;
	can_clean: number;
};

function boundedStart(value: string | undefined, max: number): string | null {
	if (!value) return null;
	return value.length <= max ? value : value.slice(0, max);
}

function boundedEnd(value: string | undefined, max: number): string | null {
	if (!value) return null;
	return value.length <= max ? value : value.slice(-max);
}

function rowToActivity(
	row: ProviderBackgroundActivityRow,
): ProviderBackgroundActivity {
	return {
		providerId: row.provider_id,
		providerSessionId: row.provider_session_id,
		activityId: row.activity_id,
		...(row.process_id ? { processId: row.process_id } : {}),
		kind: row.kind,
		// A persisted process has no live ownership after a Hlid restart. A fresh
		// provider observation may promote the same native id back to running.
		status: row.status === "running" ? "unknown" : row.status,
		...(row.command ? { command: row.command } : {}),
		...(row.description ? { description: row.description } : {}),
		...(row.cwd ? { cwd: row.cwd } : {}),
		...(row.recent_output ? { recentOutput: row.recent_output } : {}),
		...(row.os_pid != null ? { osPid: row.os_pid } : {}),
		...(row.cpu_percent != null ? { cpuPercent: row.cpu_percent } : {}),
		...(row.rss_kb != null ? { rssKb: row.rss_kb } : {}),
		startedAtMs: row.started_at_ms,
		updatedAtMs: row.updated_at_ms,
		...(row.ended_at_ms != null ? { endedAtMs: row.ended_at_ms } : {}),
		// Control flags only describe a currently attached native provider
		// session. A fresh observation must re-establish them after restore.
		capabilities: {},
	};
}

export async function listProviderBackgroundActivities(
	sessionId: string,
): Promise<ProviderBackgroundActivity[]> {
	const db = await getDb();
	return db
		.query<ProviderBackgroundActivityRow, [string, number]>(
			`SELECT provider_id, provider_session_id, activity_id, process_id,
			        kind, status, command, description, cwd, recent_output,
			        os_pid, cpu_percent, rss_kb, started_at_ms, updated_at_ms,
			        ended_at_ms, can_stop, can_terminate, can_clean
			 FROM provider_background_activities
			 WHERE session_id = ?
			 ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END,
			          updated_at_ms DESC, activity_id
			 LIMIT ?`,
		)
		.all(sessionId, MAX_PERSISTED_ACTIVITIES)
		.map(rowToActivity);
}

/** Replace the bounded background-activity snapshot for one Hlid session. */
export async function replaceSessionBackgroundActivities(
	sessionId: string,
	activities: readonly ProviderBackgroundActivity[],
): Promise<void> {
	const db = await getDb();
	const boundedActivities = [...activities]
		.sort((left, right) => right.updatedAtMs - left.updatedAtMs)
		.slice(0, MAX_PERSISTED_ACTIVITIES);
	db.transaction(() => {
		db.run(
			`DELETE FROM provider_background_activities
			 WHERE session_id = ?`,
			[sessionId],
		);
		const insert = db.prepare(`
			INSERT INTO provider_background_activities (
				session_id, provider_id, provider_session_id, activity_id,
				process_id, kind, status, command, description, cwd, recent_output,
				os_pid, cpu_percent, rss_kb, started_at_ms, updated_at_ms,
				ended_at_ms, can_stop, can_terminate, can_clean
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const activity of boundedActivities) {
			insert.run(
				sessionId,
				activity.providerId,
				activity.providerSessionId,
				activity.activityId,
				activity.processId ?? null,
				activity.kind,
				activity.status,
				boundedStart(activity.command, MAX_COMMAND_CHARS),
				boundedStart(activity.description, MAX_DESCRIPTION_CHARS),
				boundedStart(activity.cwd, MAX_CWD_CHARS),
				boundedEnd(activity.recentOutput, MAX_OUTPUT_CHARS),
				activity.osPid ?? null,
				activity.cpuPercent ?? null,
				activity.rssKb ?? null,
				activity.startedAtMs,
				activity.updatedAtMs,
				activity.endedAtMs ?? null,
				activity.capabilities.stop ? 1 : 0,
				activity.capabilities.terminate ? 1 : 0,
				activity.capabilities.clean ? 1 : 0,
			);
		}
	})();
}
