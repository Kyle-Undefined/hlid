import type {
	ProjectPreviewSnapshot,
	ProjectPreviewState,
} from "../server/protocol";
import { getDb } from "./schema";

type ProjectPreviewDbRow = {
	id: string;
	session_id: string;
	label: string;
	command: string;
	cwd: string;
	port: number;
	path: string;
	url: string;
	relay_url: string;
	state: ProjectPreviewState;
	present: number;
	started_at: string;
	expires_at: string;
	ended_at: string | null;
	exit_code: number | null;
	error: string | null;
	stop_reason: string | null;
	logs_json: string;
};

function parseLogs(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((line): line is string => typeof line === "string")
			: [];
	} catch {
		return [];
	}
}

function snapshot(row: ProjectPreviewDbRow): ProjectPreviewSnapshot {
	return {
		id: row.id,
		session_id: row.session_id,
		label: row.label,
		command: row.command,
		cwd: row.cwd,
		port: row.port,
		path: row.path,
		url: row.url,
		relay_url: row.relay_url,
		state: row.state,
		present: row.present === 1,
		started_at: row.started_at,
		expires_at: row.expires_at,
		ended_at: row.ended_at ?? undefined,
		exit_code: row.exit_code ?? undefined,
		error: row.error ?? undefined,
		stop_reason: row.stop_reason ?? undefined,
		logs: parseLogs(row.logs_json),
	};
}

export async function saveProjectPreview(
	preview: ProjectPreviewSnapshot,
): Promise<void> {
	const db = await getDb();
	db.run(
		`INSERT INTO project_previews (
			id, session_id, label, command, cwd, port, path, url, relay_url,
			state, present, started_at, expires_at, ended_at, exit_code, error,
			stop_reason, logs_json, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
		ON CONFLICT(id) DO UPDATE SET
			state = excluded.state,
			ended_at = excluded.ended_at,
			exit_code = excluded.exit_code,
			error = excluded.error,
			stop_reason = excluded.stop_reason,
			logs_json = excluded.logs_json,
			updated_at = unixepoch()`,
		[
			preview.id,
			preview.session_id,
			preview.label,
			preview.command,
			preview.cwd,
			preview.port,
			preview.path,
			preview.url,
			preview.relay_url,
			preview.state,
			preview.present ? 1 : 0,
			preview.started_at,
			preview.expires_at,
			preview.ended_at ?? null,
			preview.exit_code ?? null,
			preview.error ?? null,
			preview.stop_reason ?? null,
			JSON.stringify(preview.logs),
		],
	);
}

export async function getProjectPreview(
	previewId: string,
): Promise<ProjectPreviewSnapshot | null> {
	const db = await getDb();
	const row = db
		.query<ProjectPreviewDbRow, [string]>(
			`SELECT id, session_id, label, command, cwd, port, path, url, relay_url,
			        state, present, started_at, expires_at, ended_at, exit_code,
			        error, stop_reason, logs_json
			 FROM project_previews WHERE id = ?`,
		)
		.get(previewId);
	return row ? snapshot(row) : null;
}

export async function stopActiveProjectPreviewsAfterRestart(): Promise<number> {
	const db = await getDb();
	const result = db.run(
		`UPDATE project_previews
		 SET state = 'stopped',
		     ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		     stop_reason = 'hlid_restart',
		     error = COALESCE(error, 'Hlid restarted while this preview was running.'),
		     updated_at = unixepoch()
		 WHERE state IN ('starting', 'ready')`,
	);
	return result.changes;
}

export async function deleteProjectPreviewsForSessions(
	sessionIds: string[],
): Promise<void> {
	if (sessionIds.length === 0) return;
	const db = await getDb();
	const placeholders = sessionIds.map(() => "?").join(",");
	db.run(
		`DELETE FROM project_previews WHERE session_id IN (${placeholders})`,
		sessionIds,
	);
}
