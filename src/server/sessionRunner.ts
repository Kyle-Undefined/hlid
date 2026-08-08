import { randomUUID } from "node:crypto";
import type { RoutineRunRow } from "../db";
import * as db from "../db";
import { routineProviderCommandText } from "../lib/commands";
import type {
	RoutineGrant,
	RoutinePermissionContext,
} from "../lib/routinePermissions";
import type { RoutineSummary } from "../lib/routines";
import { bumpDataRevision } from "./dataRevision";
import type { HlidDelegationManager } from "./hlidDelegation";
import type { ChatAttachment, ServerMessage } from "./protocol";
import { deliverRoutineResult } from "./routineDelivery";
import type { SessionPool } from "./sessionPool";

export type RoutineSessionResult = {
	status:
		| "succeeded"
		| "delivery_error"
		| "action_required"
		| "provider_unavailable"
		| "failed";
	sessionId: string | null;
	error?: string;
	actionRequired?: string;
	delivery?: unknown;
};

function changesSessionAttention(event: ServerMessage): boolean {
	return (
		event.type === "status" ||
		event.type === "permission_request" ||
		event.type === "ask_user_question" ||
		event.type === "plan_mode_exit" ||
		event.type === "goal_state"
	);
}

async function routineAttachments(
	routine: RoutineSummary,
): Promise<ChatAttachment[]> {
	const attachments: ChatAttachment[] = [];
	for (const id of routine.relicIds) {
		const row = await db.getAttachment(id);
		if (!row || row.retention !== "retained") {
			throw new Error(`Retained Relic ${id} is no longer available`);
		}
		attachments.push({
			id: row.id,
			path: row.path,
			filename: row.filename,
			mime: row.mime,
			kind: row.kind,
			reference: "relic",
		});
	}
	return attachments;
}

export async function runRoutineSession(options: {
	pool: SessionPool;
	delegations: HlidDelegationManager;
	routine: RoutineSummary;
	run: RoutineRunRow;
	onStatusChange?: () => void;
}): Promise<RoutineSessionResult> {
	const { pool, delegations, routine, run, onStatusChange } = options;
	const provider = pool.getProvider(routine.providerId);
	if (!provider) {
		return {
			status: "provider_unavailable",
			sessionId: null,
			error: `Provider ${routine.providerId} is not registered`,
		};
	}
	let availability: { available: boolean; reason?: string };
	try {
		availability = provider.check
			? await provider.check()
			: { available: true };
	} catch (error) {
		return {
			status: "provider_unavailable",
			sessionId: null,
			error: `${routine.providerId} availability check failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	if (!availability.available) {
		return {
			status: "provider_unavailable",
			sessionId: null,
			error:
				availability.reason ?? `Provider ${routine.providerId} is unavailable`,
		};
	}
	const attachments = await routineAttachments(routine);
	const entry = pool.create(routine.agentCwd, routine.agentName, true);
	const sessionId = entry.sessionId;
	const grants = routine.grants.map(
		(grant): RoutineGrant => ({ ...grant, id: grant.id ?? randomUUID() }),
	);
	let actionRequiredWork: Promise<void> | null = null;
	const routineContext: RoutinePermissionContext = {
		routineId: routine.id,
		runId: run.id,
		profileId: run.profile_id ?? "",
		revision: run.routine_revision,
		authorizationFingerprint: run.authorization_fingerprint,
		mode: routine.permissionMode,
		providerId: routine.providerId,
		approvedCwd: routine.agentCwd,
		grants,
		onGrantUsed: (grant, request, toolUseId) =>
			db.recordRoutineGrantUse({
				runId: run.id,
				grantId: grant.id,
				toolUseId,
				request,
				decision: "approved_routine",
			}),
		onActionRequired: (reason) => {
			actionRequiredWork ??= Promise.allSettled([
				db.pauseRoutine(routine.id, reason),
				delegations.cancelRoutineRun(run.id),
			]).then((results) => {
				for (const result of results) {
					if (result.status === "rejected") {
						console.error(
							`[routine ${run.id}] action-required cleanup failed:`,
							result.reason,
						);
					}
				}
				onStatusChange?.();
			});
			return actionRequiredWork;
		},
	};
	let entryClosed = false;
	const settleRoutineOwnership = async () => {
		if (!entryClosed) {
			pool.close(entry.sessionId);
			entryClosed = true;
			onStatusChange?.();
		}
		const childRuns = await delegations.waitForRoutineRun(run.id);
		if (actionRequiredWork) await actionRequiredWork;
		return childRuns;
	};
	try {
		await entry.manager.setProvider(routine.providerId, {
			model: routine.model || undefined,
			effort: routine.effort || undefined,
			permissionMode:
				routine.permissionMode === "full_access"
					? "bypassPermissions"
					: "default",
		});
		if (entry.manager.getProviderId() !== routine.providerId) {
			throw new Error(
				`Routine provider drifted from ${routine.providerId} to ${entry.manager.getProviderId()}`,
			);
		}
		await db.markRoutineRunRunning({
			runId: run.id,
			sessionId,
			providerUsed: routine.providerId,
			now: Math.floor(Date.now() / 1_000),
		});
		bumpDataRevision("routines", "sessions");
		await entry.manager.runQuery(
			routineProviderCommandText(
				routine.providerId,
				routine.providerCommands,
				routine.prompt,
			),
			(message) => {
				entry.runState.broadcast(message);
				if (changesSessionAttention(message)) onStatusChange?.();
			},
			{
				inputOrigin: "scheduled-task",
				sessionId,
				skillContexts: routine.skillContexts,
				attachments,
				agentCwd: routine.agentCwd,
				turnId: `routine-${run.id}`,
				planMode: false,
				planHtml: false,
				vaultReferences: routine.vaultReferences,
				routineContext,
			},
		);
		const providerFailed = entry.manager.getStatus().state === "error";
		const childRuns = await settleRoutineOwnership();
		if (routineContext.actionRequired) {
			return {
				status: "action_required",
				sessionId,
				actionRequired: routineContext.actionRequired.reason,
			};
		}
		if (providerFailed) {
			return {
				status: "failed",
				sessionId,
				error: "The provider session ended in an error state",
			};
		}
		const failedChild = childRuns.find((child) => child.status !== "completed");
		if (failedChild) {
			return {
				status: "failed",
				sessionId,
				error:
					failedChild.error ??
					`Delegated child ${failedChild.id} ended with ${failedChild.status}.`,
			};
		}
		const delivery = await deliverRoutineResult({
			sessionId,
			routineName: routine.name,
			agentCwd: routine.agentCwd,
			deliveries: routine.deliveries,
		});
		return {
			status: delivery.some((item) => !item.ok)
				? "delivery_error"
				: "succeeded",
			sessionId,
			delivery,
		};
	} catch (error) {
		await settleRoutineOwnership();
		return {
			status: routineContext.actionRequired ? "action_required" : "failed",
			sessionId,
			...(routineContext.actionRequired
				? { actionRequired: routineContext.actionRequired.reason }
				: {
						error: error instanceof Error ? error.message : String(error),
					}),
		};
	} finally {
		if (!entryClosed) pool.close(entry.sessionId);
		onStatusChange?.();
		bumpDataRevision("routines", "sessions", "stats");
	}
}
