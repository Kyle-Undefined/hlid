import { randomUUID } from "node:crypto";
import * as db from "../db";
import type { ProviderInfo } from "../lib/providerTypes";
import type {
	RoutineNotificationPolicy,
	RoutineSummary,
} from "../lib/routines";
import { bumpDataRevision } from "./dataRevision";
import type { HlidDelegationManager } from "./hlidDelegation";
import type { SessionPool } from "./sessionPool";
import { type RoutineSessionResult, runRoutineSession } from "./sessionRunner";

const POLL_MS = 15_000;
const LEASE_SECONDS = 120;
const LEASE_REFRESH_MS = 30_000;
const MAX_COMPLETION_MESSAGE_CHARS = 500;

export type RoutineRunCompletionReason =
	| "routine_succeeded"
	| "routine_action_required"
	| "routine_failed"
	| "routine_delivery_error"
	| "routine_provider_unavailable";

/** Durable terminal Routine outcome emitted only after its run row is finished.
 * Timestamps use the same Unix-second unit as Routine persistence. */
export type RoutineRunCompletionEvent = {
	routine: RoutineSummary | null;
	notificationPolicy: RoutineNotificationPolicy;
	routineId: string;
	runId: string;
	rootSessionId: string | null;
	status: RoutineSessionResult["status"];
	reason: RoutineRunCompletionReason;
	message: string;
	createdAt: number;
	scheduledAt: number;
	claimedAt: number | null;
	startedAt: number | null;
	finishedAt: number;
	url: string;
};

export type RoutineRunCompletionCallback = (
	event: RoutineRunCompletionEvent,
) => void | Promise<void>;

function completionReason(
	status: RoutineSessionResult["status"],
): RoutineRunCompletionReason {
	switch (status) {
		case "succeeded":
			return "routine_succeeded";
		case "action_required":
			return "routine_action_required";
		case "delivery_error":
			return "routine_delivery_error";
		case "provider_unavailable":
			return "routine_provider_unavailable";
		case "failed":
			return "routine_failed";
	}
}

function boundedCompletionMessage(value: string, fallback: string): string {
	let safe = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		safe += code <= 31 || code === 127 ? " " : character;
	}
	const normalized = safe.replace(/\s+/g, " ").trim();
	return (normalized || fallback).slice(0, MAX_COMPLETION_MESSAGE_CHARS);
}

function deliveryError(result: RoutineSessionResult): string | null {
	if (!Array.isArray(result.delivery)) return null;
	for (const item of result.delivery) {
		if (
			typeof item === "object" &&
			item !== null &&
			!Array.isArray(item) &&
			"ok" in item &&
			item.ok === false &&
			"error" in item &&
			typeof item.error === "string"
		)
			return item.error;
	}
	return null;
}

function completionMessage(
	routine: RoutineSummary | null,
	result: RoutineSessionResult,
): string {
	const name = routine?.name ?? "Routine";
	switch (result.status) {
		case "succeeded":
			return boundedCompletionMessage(
				`${name} finished successfully.`,
				"Routine finished successfully.",
			);
		case "action_required":
			return boundedCompletionMessage(
				`${name} needs action: ${result.actionRequired ?? result.error ?? "Open Hlid to continue."}`,
				"Routine needs action.",
			);
		case "delivery_error":
			return boundedCompletionMessage(
				`${name} finished, but delivery failed: ${deliveryError(result) ?? result.error ?? "One or more destinations could not be updated."}`,
				"Routine delivery failed.",
			);
		case "provider_unavailable":
			return boundedCompletionMessage(
				`${name} could not start: ${result.error ?? "The configured provider is unavailable."}`,
				"Routine provider is unavailable.",
			);
		case "failed":
			return boundedCompletionMessage(
				`${name} failed: ${result.error ?? "The run did not complete."}`,
				"Routine failed.",
			);
	}
}

function routineRunUrl(routineId: string, runId: string): string {
	const search = new URLSearchParams();
	search.set("routine", routineId);
	search.set("routine_run", runId);
	return `/?${search}`;
}

export class RoutineScheduler {
	private readonly bootId = randomUUID();
	private readonly pool: SessionPool;
	private readonly delegations: HlidDelegationManager;
	private readonly providerCatalog: (cwd: string) => Promise<ProviderInfo[]>;
	private timer: ReturnType<typeof setInterval> | null = null;
	private active = new Set<string>();
	private pending: db.RoutineRunRow[] = [];
	private ticking = false;
	private readonly onStatusChange?: () => void;
	private readonly onRunComplete?: RoutineRunCompletionCallback;

	constructor(
		pool: SessionPool,
		delegations: HlidDelegationManager,
		providerCatalog: (cwd: string) => Promise<ProviderInfo[]>,
		onStatusChange?: () => void,
		onRunComplete?: RoutineRunCompletionCallback,
	) {
		this.pool = pool;
		this.delegations = delegations;
		this.providerCatalog = providerCatalog;
		this.onStatusChange = onStatusChange;
		this.onRunComplete = onRunComplete;
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
		let routine: RoutineSummary | null = null;
		let result: RoutineSessionResult;
		try {
			routine = await db.getRoutine(run.routine_id);
			if (!routine) throw new Error("Routine definition was removed");
			if (
				routine.revision !== run.routine_revision ||
				routine.authorizationFingerprint !== run.authorization_fingerprint
			) {
				throw new Error(
					"Routine authorization changed after this run was claimed",
				);
			}
			result = await runRoutineSession({
				pool: this.pool,
				delegations: this.delegations,
				providerCatalog: this.providerCatalog,
				routine,
				run,
				onStatusChange: this.onStatusChange,
			});
		} catch (error) {
			result = {
				status: "failed",
				sessionId: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			const finishedAt = Math.floor(Date.now() / 1_000);
			await db.finishRoutineRun({
				runId: run.id,
				status: result.status,
				now: finishedAt,
				error: result.error,
				actionRequired: result.actionRequired,
				delivery: result.delivery,
			});
			if (
				result.status === "action_required" ||
				result.status === "provider_unavailable"
			) {
				// Pause is part of the terminal Routine state, not notification side
				// effect. Persist it before a callback that may be slow or crash.
				await db.pauseRoutine(
					run.routine_id,
					result.actionRequired ??
						result.error ??
						"A scheduled action needs approval",
				);
			}
			if (this.onRunComplete) {
				try {
					await this.onRunComplete({
						routine,
						notificationPolicy: db.routineRunNotificationPolicy(run),
						routineId: run.routine_id,
						runId: run.id,
						rootSessionId: result.sessionId ?? run.session_id,
						status: result.status,
						reason: completionReason(result.status),
						message: completionMessage(routine, result),
						createdAt: run.created_at,
						scheduledAt: run.scheduled_for,
						claimedAt: run.claimed_at,
						startedAt: result.startedAt ?? run.started_at,
						finishedAt,
						url: routineRunUrl(run.routine_id, run.id),
					});
				} catch (error) {
					console.error(
						`[routine ${run.id}] completion callback failed:`,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		} finally {
			clearInterval(lease);
			bumpDataRevision("routines", "sessions", "stats");
		}
	}
}

let activeScheduler: RoutineScheduler | null = null;

export async function startRoutineScheduler(
	pool: SessionPool,
	delegations: HlidDelegationManager,
	providerCatalog: (cwd: string) => Promise<ProviderInfo[]>,
	onStatusChange?: () => void,
	onRunComplete?: RoutineRunCompletionCallback,
): Promise<RoutineScheduler> {
	activeScheduler?.stop();
	const scheduler = new RoutineScheduler(
		pool,
		delegations,
		providerCatalog,
		onStatusChange,
		onRunComplete,
	);
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
