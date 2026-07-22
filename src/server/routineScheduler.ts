import { randomUUID } from "node:crypto";
import * as db from "../db";
import { bumpDataRevision } from "./dataRevision";
import type { SessionPool } from "./sessionPool";
import { runRoutineSession } from "./sessionRunner";

const POLL_MS = 15_000;
const LEASE_SECONDS = 120;
const LEASE_REFRESH_MS = 30_000;

export class RoutineScheduler {
	private readonly bootId = randomUUID();
	private readonly pool: SessionPool;
	private timer: ReturnType<typeof setInterval> | null = null;
	private active = new Set<string>();
	private pending: db.RoutineRunRow[] = [];
	private ticking = false;

	constructor(pool: SessionPool) {
		this.pool = pool;
	}

	async start(): Promise<void> {
		const now = Math.floor(Date.now() / 1_000);
		// A new process cannot inherit an in-flight provider session from the old
		// process, even when its persisted lease had time remaining.
		await db.interruptStaleRoutineRuns(now, Number.MAX_SAFE_INTEGER);
		this.timer = setInterval(() => void this.tick(), POLL_MS);
		await this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async runNow(routineId: string): Promise<db.RoutineRunRow> {
		if (this.active.size > 0 || this.pending.length > 0) {
			throw new Error("Another Routine is already running or queued");
		}
		const run = await db.claimManualRoutineRun({
			routineId,
			now: Math.floor(Date.now() / 1_000),
			leaseOwner: this.bootId,
			leaseSeconds: LEASE_SECONDS,
		});
		this.pending.push(run);
		bumpDataRevision("routines");
		void this.drain();
		return run;
	}

	private async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const capacity = Math.max(0, 1 - this.active.size - this.pending.length);
			if (capacity === 0) return;
			const claimed = await db.claimDueRoutineRuns({
				now: Math.floor(Date.now() / 1_000),
				leaseOwner: this.bootId,
				leaseSeconds: LEASE_SECONDS,
				limit: capacity,
			});
			this.pending.push(...claimed);
			if (claimed.length > 0) bumpDataRevision("routines");
			await this.drain();
		} finally {
			this.ticking = false;
		}
	}

	private async drain(): Promise<void> {
		if (this.active.size >= 1) return;
		const run = this.pending.shift();
		if (!run) return;
		this.active.add(run.id);
		void this.execute(run).finally(() => {
			this.active.delete(run.id);
			void this.drain();
		});
	}

	private async execute(run: db.RoutineRunRow): Promise<void> {
		const lease = setInterval(
			() =>
				void db.renewRoutineRunLease(
					run.id,
					this.bootId,
					Math.floor(Date.now() / 1_000),
					LEASE_SECONDS,
				),
			LEASE_REFRESH_MS,
		);
		try {
			const routine = await db.getRoutine(run.routine_id);
			if (!routine) throw new Error("Routine definition was removed");
			if (
				routine.revision !== run.routine_revision ||
				routine.authorizationFingerprint !== run.authorization_fingerprint
			) {
				throw new Error(
					"Routine authorization changed after this run was claimed",
				);
			}
			const result = await runRoutineSession({
				pool: this.pool,
				routine,
				run,
			});
			await db.finishRoutineRun({
				runId: run.id,
				status: result.status,
				now: Math.floor(Date.now() / 1_000),
				error: result.error,
				actionRequired: result.actionRequired,
				delivery: result.delivery,
			});
			if (
				result.status === "action_required" ||
				result.status === "provider_unavailable"
			) {
				await db.pauseRoutine(
					run.routine_id,
					result.actionRequired ??
						result.error ??
						"A scheduled action needs approval",
				);
			}
		} catch (error) {
			await db.finishRoutineRun({
				runId: run.id,
				status: "failed",
				now: Math.floor(Date.now() / 1_000),
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearInterval(lease);
			bumpDataRevision("routines", "sessions", "stats");
		}
	}
}

let activeScheduler: RoutineScheduler | null = null;

export async function startRoutineScheduler(
	pool: SessionPool,
): Promise<RoutineScheduler> {
	activeScheduler?.stop();
	const scheduler = new RoutineScheduler(pool);
	activeScheduler = scheduler;
	await scheduler.start();
	return scheduler;
}

export function stopRoutineScheduler(): void {
	activeScheduler?.stop();
	activeScheduler = null;
}

export async function runRoutineNow(
	routineId: string,
): Promise<db.RoutineRunRow> {
	if (!activeScheduler) throw new Error("Routine scheduler is not running");
	return activeScheduler.runNow(routineId);
}
