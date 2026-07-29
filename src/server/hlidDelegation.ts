import { randomUUID } from "node:crypto";
import * as db from "../db";
import type { ProviderInfo } from "../lib/providerTypes";
import type { RoutinePermissionContext } from "../lib/routinePermissions";
import { SESSION_LABEL_LENGTH } from "../lib/utils";
import type { WorkspaceReferenceRequest } from "../lib/vaultReferences";
import type { AgentProvider } from "./agentProvider";
import {
	type DelegateHlidAgentInput,
	HLID_DELEGATION_MAX_ACTIVE_GLOBAL,
	HLID_DELEGATION_MAX_ACTIVE_PER_PARENT,
	HLID_DELEGATION_MAX_DEPTH,
	HLID_DELEGATION_MAX_HANDOFF_CHARS,
	type HlidDelegationHandoffSummary,
	type HlidDelegationSnapshot,
	isTerminalHlidDelegationStatus,
	type ResumeHlidAgentInput,
} from "./hlidDelegationSchemas";
import type { ChatAttachment, ServerMessage } from "./protocol";
import type { CurrentDelegationHandoff } from "./session";
import type { PoolEntry, SessionPool } from "./sessionPool";

const PROVIDER_CHECK_TIMEOUT_MS = 15_000;
const ABORT_SETTLE_TIMEOUT_MS = 5_000;
const LEGACY_DELEGATION_TIMEOUT_SECONDS = 600;
const VISIBLE_HANDOFF_MESSAGE_LIMIT = 100;
const LIST_TASK_PREVIEW_CHARS = 240;

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

type RunPayload = {
	instruction: string;
	skillContexts: string[];
	relics: ChatAttachment[];
	vaultReferences: string[];
	workspaceReferences: WorkspaceReferenceRequest[];
	delegationContext?: string;
	routineContext?: RoutinePermissionContext;
};

type ActiveDelegationRun = {
	entry: PoolEntry;
	completion: Promise<void>;
	requestCancel: () => void;
	routineRunId: string | null;
};

const CHILD_PERMISSION_MODES: Record<
	PermissionMode,
	ReadonlySet<PermissionMode>
> = {
	default: new Set(["default", "plan"]),
	acceptEdits: new Set(["default", "acceptEdits", "plan"]),
	bypassPermissions: new Set([
		"default",
		"acceptEdits",
		"bypassPermissions",
		"plan",
	]),
	plan: new Set(["plan"]),
};

function changesSessionAttention(event: ServerMessage): boolean {
	return (
		event.type === "status" ||
		event.type === "permission_request" ||
		event.type === "ask_user_question" ||
		event.type === "plan_mode_exit" ||
		event.type === "goal_state" ||
		event.type === "done" ||
		event.type === "error"
	);
}

function delegationProgressText(event: ServerMessage): string | null {
	if (event.type === "status" && event.state === "running") {
		return "Provider turn running";
	}
	if (event.type === "tool_event") return `Using ${event.name}`;
	if (event.type === "tool_result") return "Provider turn running";
	if (event.type === "permission_request") return "Waiting for approval";
	if (event.type === "ask_user_question") return "Waiting for input";
	if (event.type === "plan_mode_exit") return "Waiting for plan review";
	if (event.type === "agent_sleep") return "Waiting for provider usage window";
	if (event.type === "done") return "Finishing provider turn";
	return null;
}

function boundedSessionLabel(task: string): string {
	return task.slice(0, SESSION_LABEL_LENGTH).toUpperCase();
}

function delegatedAssistantText(
	messages: Awaited<ReturnType<typeof db.getSessionMessages>>,
	startSequence: number,
): string | null {
	return (
		messages
			.find(
				(message) =>
					message.seq >= startSequence &&
					message.role === "assistant" &&
					message.text.trim(),
			)
			?.text.trim() ?? null
	);
}

function boundedVisibleTranscript(
	messages: Awaited<ReturnType<typeof db.getSessionMessages>>,
	excludedAssistantSequence?: number | null,
): string {
	const transcript = messages
		.filter(
			(message) =>
				message.role === "user" ||
				(message.role === "assistant" &&
					message.seq !== excludedAssistantSequence),
		)
		.map((message) => `${message.role.toUpperCase()}: ${message.text}`)
		.join("\n\n");
	if (transcript.length <= HLID_DELEGATION_MAX_HANDOFF_CHARS) {
		return transcript;
	}
	return `…${transcript.slice(-(HLID_DELEGATION_MAX_HANDOFF_CHARS - 1))}`;
}

function emptyHandoffSummary(): HlidDelegationHandoffSummary {
	return {
		visible_transcript_chars: 0,
		selected_skills: 0,
		selected_relics: 0,
		vault_references: 0,
		workspace_references: 0,
	};
}

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Provider availability check timed out.")),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function assertProviderAvailable(provider: AgentProvider): Promise<void> {
	const availability = provider.check
		? await timeout(provider.check(), PROVIDER_CHECK_TIMEOUT_MS)
		: { available: true };
	if (!availability.available) {
		throw new Error(
			availability.reason ??
				`Provider ${provider.label ?? provider.providerId} is unavailable.`,
		);
	}
}

async function settleAfterAbort(promise: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	await Promise.race([
		promise
			.catch(() => {})
			.then(() => {
				settled = true;
			}),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ABORT_SETTLE_TIMEOUT_MS);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
	// A provider that is slow to acknowledge cancellation remains owned by the
	// delegation. Do not free capacity or permit a manual takeover while its
	// process can still emit events.
	if (!settled) await promise.catch(() => {});
}

function collectCancellationError(errors: unknown[], error: unknown): void {
	if (error instanceof AggregateError) {
		for (const nestedError of error.errors) {
			collectCancellationError(errors, nestedError);
		}
		return;
	}
	errors.push(error);
}

function reportedQueryTokens(event: ServerMessage): number | null {
	if (event.type === "usage_update") {
		return (
			event.query_input_tokens +
			event.query_output_tokens +
			event.query_cache_read_tokens +
			event.query_cache_creation_tokens
		);
	}
	if (event.type === "done") {
		return (
			event.input_tokens +
			event.output_tokens +
			event.cache_read_tokens +
			event.cache_creation_tokens
		);
	}
	return null;
}

function reportedQueryCost(event: ServerMessage): number | null {
	if (event.type === "usage_update") {
		return typeof event.query_estimated_cost === "number"
			? event.query_estimated_cost
			: null;
	}
	if (event.type === "done") {
		if (typeof event.cost === "number") return event.cost;
		return typeof event.estimated_cost === "number"
			? event.estimated_cost
			: null;
	}
	return null;
}

function queueDelegationPersistence(
	pending: Promise<void>,
	delegationId: string,
	kind: "progress" | "token" | "cost",
	persist: () => Promise<unknown>,
	onPersisted: () => void,
): Promise<void> {
	return pending
		.then(() => persist())
		.then(() => onPersisted())
		.catch((error) => {
			console.error(
				`[delegation ${delegationId}] ${kind} persistence failed:`,
				error instanceof Error ? error.message : String(error),
			);
		});
}

export function childPermissionModeAllowed(
	parentMode: string,
	childMode: string,
): boolean {
	const parent = CHILD_PERMISSION_MODES[parentMode as PermissionMode];
	return Boolean(parent?.has(childMode as PermissionMode));
}

function validateProviderSelection(
	provider: ProviderInfo | undefined,
	input: DelegateHlidAgentInput,
	permissionMode: PermissionMode,
): void {
	if (provider?.available === false) {
		throw new Error(
			provider.unavailableReason
				? `${provider.label} is unavailable: ${provider.unavailableReason}`
				: `${provider.label} is unavailable.`,
		);
	}
	if (
		input.model &&
		provider?.models &&
		provider.models.length > 0 &&
		!provider.models.some((model) => model.value === input.model)
	) {
		throw new Error(
			`Model ${input.model} is not in ${provider.label}'s current model catalog.`,
		);
	}
	if (input.effort && provider) {
		const modelEfforts = provider.models?.find(
			(model) => model.value === input.model,
		)?.efforts;
		const efforts =
			modelEfforts && modelEfforts.length > 0
				? modelEfforts
				: provider.effortLevels;
		if (
			efforts &&
			efforts.length > 0 &&
			!efforts.some((effort) => effort.value === input.effort)
		) {
			throw new Error(
				`Effort ${input.effort} is not available for the selected ${provider.label} model.`,
			);
		}
	}
	if (input.service_tier && provider) {
		const selectedModel =
			provider.models?.find((model) => model.value === input.model) ??
			(!input.model
				? provider.models?.find((model) => model.isDefault)
				: undefined);
		if (
			!selectedModel?.serviceTiers?.some(
				(tier) => tier.value === input.service_tier,
			)
		) {
			throw new Error(
				`Service tier ${input.service_tier} is not available for the selected ${provider.label} model.`,
			);
		}
	}
	if (
		permissionMode !== "plan" &&
		provider?.permissionModes &&
		provider.permissionModes.length > 0 &&
		!provider.permissionModes.some((mode) => mode.value === permissionMode)
	) {
		throw new Error(
			`Permission mode ${permissionMode} is not available for ${provider.label}.`,
		);
	}
}

export class HlidDelegationManager {
	private active = new Map<string, ActiveDelegationRun>();
	private cancellationRequested = new Set<string>();
	private hierarchyTail: Promise<void> = Promise.resolve();
	private resumeTails = new Map<string, Promise<void>>();

	constructor(
		private readonly pool: SessionPool,
		private readonly providerCatalog: () => Promise<ProviderInfo[]>,
		private readonly onStatusChange: () => void,
	) {}

	private notifyStatusChange(): void {
		try {
			this.onStatusChange();
		} catch (error) {
			console.error(
				"[delegation] failed to publish child status:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private emitFor(entry: PoolEntry, event: ServerMessage): void {
		entry.runState.broadcast(event);
		if (changesSessionAttention(event)) this.notifyStatusChange();
	}

	private retireTerminalRuntime(
		entry: PoolEntry,
		childSessionId: string,
	): boolean {
		if (
			entry.manager.isRunning() ||
			this.pool.findByDbSessionId(childSessionId) !== entry
		) {
			return false;
		}
		if (entry.runState.getSubscriberCount() === 0) {
			this.pool.close(entry.sessionId);
		} else {
			// A connected Raven client still owns this lightweight entry. Retire
			// the provider process without invalidating that client's subscription;
			// a later prompt can rebuild provider state from the durable chat.
			entry.manager.abort();
		}
		return true;
	}

	private async withHierarchyLock<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.hierarchyTail;
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.hierarchyTail = current;
		await previous;
		try {
			return await action();
		} finally {
			release?.();
		}
	}

	private async withResumeLock<T>(
		delegationId: string,
		action: () => Promise<T>,
	): Promise<T> {
		const previous = this.resumeTails.get(delegationId) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.resumeTails.set(delegationId, current);
		await previous;
		try {
			return await action();
		} finally {
			release?.();
			if (this.resumeTails.get(delegationId) === current) {
				this.resumeTails.delete(delegationId);
			}
		}
	}

	private requireRunningParent(
		parentSessionId: string,
		action: "delegation" | "continuation",
	): PoolEntry {
		const parent = this.pool.findByDbSessionId(parentSessionId);
		if (!parent || parent.manager.getCurrentSessionId() !== parentSessionId) {
			throw new Error(
				`The parent Raven session is not live. ${action === "delegation" ? "Delegation" : "Continuation"} must start from an active provider turn.`,
			);
		}
		const parentStatus = parent.manager.getStatus();
		if (
			parentStatus.state !== "running" ||
			!parent.manager.getCurrentTurnId()
		) {
			throw new Error(
				`${action === "delegation" ? "Delegation" : "Continuation"} must be created while the parent turn is running.`,
			);
		}
		return parent;
	}

	private activeParentWorkspace(parent: PoolEntry): string {
		// Restored sessions load their persisted workspace into SessionManager.
		// PoolEntry retains the client-supplied creation cwd, so use it only as the
		// vault/root fallback when the active manager has no agent workspace.
		return parent.manager.getAgentCwd() ?? parent.agentCwd;
	}

	private assertSameRunningParentTurn(
		parent: PoolEntry,
		parentSessionId: string,
		parentTurnId: string | null,
		action: "delegation" | "continuation",
	): void {
		if (
			!parentTurnId ||
			this.pool.findByDbSessionId(parentSessionId) !== parent ||
			parent.manager.getCurrentSessionId() !== parentSessionId ||
			parent.manager.getCurrentTurnId() !== parentTurnId ||
			parent.manager.getStatus().state !== "running"
		) {
			throw new Error(
				`The parent turn changed before ${action} could start. No child turn was created.`,
			);
		}
	}

	private async initialHandoff(
		parentSessionId: string,
		current: CurrentDelegationHandoff | null,
		input: DelegateHlidAgentInput,
	): Promise<{
		payload: Omit<RunPayload, "instruction">;
		summary: HlidDelegationHandoffSummary;
	}> {
		const requested = input.handoff;
		if (
			requested &&
			Object.values(requested).some(Boolean) &&
			current === null
		) {
			throw new Error(
				"The parent turn has no validated context available for delegation handoff.",
			);
		}
		const skillContexts =
			requested?.selected_skills && current ? current.skillContexts : [];
		const relics = requested?.selected_relics && current ? current.relics : [];
		const vaultReferences =
			requested?.exact_references && current ? current.vaultReferences : [];
		const workspaceReferences =
			requested?.exact_references && current ? current.workspaceReferences : [];
		let delegationContext: string | undefined;
		if (requested?.visible_transcript) {
			delegationContext = boundedVisibleTranscript(
				await db.getSessionMessages(
					parentSessionId,
					undefined,
					VISIBLE_HANDOFF_MESSAGE_LIMIT,
				),
				current?.currentAssistantSequence,
			);
		}
		return {
			payload: {
				skillContexts,
				relics,
				vaultReferences,
				workspaceReferences,
				...(delegationContext ? { delegationContext } : {}),
			},
			summary: {
				visible_transcript_chars: delegationContext?.length ?? 0,
				selected_skills: skillContexts.length,
				selected_relics: relics.length,
				vault_references: vaultReferences.length,
				workspace_references: workspaceReferences.length,
			},
		};
	}

	private async assertActiveCapacity(parentSessionId: string): Promise<void> {
		const [parentActive, globalActive] = await Promise.all([
			db.countActiveHlidDelegations(parentSessionId),
			db.countActiveHlidDelegations(),
		]);
		if (parentActive >= HLID_DELEGATION_MAX_ACTIVE_PER_PARENT) {
			throw new Error(
				`A parent can have at most ${HLID_DELEGATION_MAX_ACTIVE_PER_PARENT} active delegated children.`,
			);
		}
		if (globalActive >= HLID_DELEGATION_MAX_ACTIVE_GLOBAL) {
			throw new Error(
				`Hlid can run at most ${HLID_DELEGATION_MAX_ACTIVE_GLOBAL} delegated children at once.`,
			);
		}
	}

	async delegate(
		parentSessionId: string,
		input: DelegateHlidAgentInput,
	): Promise<HlidDelegationSnapshot> {
		const parent = this.requireRunningParent(parentSessionId, "delegation");
		const routineContext = parent.manager.getCurrentRoutinePermissionContext();
		const parentTurnId = parent.manager.getCurrentTurnId();
		const parentWorkspace = this.activeParentWorkspace(parent);
		const workspace = this.pool.resolveDelegationWorkspace(
			input.cwd ?? parentWorkspace,
		);
		if (!workspace) {
			throw new Error(
				input.cwd
					? "The requested delegation workspace is not the configured vault or an exact registered workspace."
					: "The parent workspace is no longer available in Hlid's configured workspace catalog.",
			);
		}
		if (
			routineContext &&
			this.pool.resolveDelegationWorkspace(routineContext.approvedCwd) !==
				workspace
		) {
			throw new Error(
				"A Routine delegation must stay in the Routine's approved workspace.",
			);
		}
		const parentStatus = parent.manager.getStatus();
		const parentDelegation =
			await db.getHlidDelegationByChildSession(parentSessionId);
		const depth = (parentDelegation?.depth ?? 0) + 1;
		if (depth > HLID_DELEGATION_MAX_DEPTH) {
			throw new Error(
				`Hlid delegation is bounded to ${HLID_DELEGATION_MAX_DEPTH} levels.`,
			);
		}
		if (parentDelegation && parentDelegation.status !== "running") {
			throw new Error(
				"Only a running Hlid delegation can create nested children.",
			);
		}

		const provider = this.pool.getProvider(input.provider);
		if (!provider) {
			throw new Error(`Provider ${input.provider} is not registered.`);
		}
		await assertProviderAvailable(provider);

		const parentPermissionMode =
			parent.manager.getCurrentTurnPermissionMode() ??
			parentStatus.permission_mode;
		const permissionMode = (input.permission_mode ??
			parentPermissionMode) as PermissionMode;
		if (!childPermissionModeAllowed(parentPermissionMode, permissionMode)) {
			throw new Error(
				`A ${parentPermissionMode} parent cannot delegate with broader ${permissionMode} permissions.`,
			);
		}
		const sameProvider = parent.manager.getProviderId() === input.provider;
		const model =
			input.model ??
			(sameProvider && parentStatus.model ? parentStatus.model : undefined);
		const effort =
			input.effort ??
			(sameProvider && parentStatus.effort ? parentStatus.effort : undefined);
		const providerInfo = (await this.providerCatalog()).find(
			(candidate) => candidate.id === input.provider,
		);
		if (!providerInfo) {
			throw new Error(
				`Provider ${input.provider} is missing from the current provider catalog.`,
			);
		}
		validateProviderSelection(
			providerInfo,
			{
				...input,
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			},
			permissionMode,
		);
		const handoff = await this.initialHandoff(
			parentSessionId,
			parent.manager.getCurrentDelegationHandoff(),
			input,
		);
		// Retained only because existing databases require this legacy column.
		// New delegated turns do not enforce a wall-clock or inactivity timeout.
		const timeoutSeconds = LEGACY_DELEGATION_TIMEOUT_SECONDS;
		const delegationId = randomUUID();
		return this.withHierarchyLock(async () => {
			this.assertSameRunningParentTurn(
				parent,
				parentSessionId,
				parentTurnId,
				"delegation",
			);
			const admittedParent =
				await db.getHlidDelegationByChildSession(parentSessionId);
			if (parentDelegation) {
				if (
					admittedParent?.id !== parentDelegation.id ||
					admittedParent.status !== "running" ||
					this.cancellationRequested.has(admittedParent.id)
				) {
					throw new Error(
						"Only a running Hlid delegation can create nested children.",
					);
				}
			} else if (admittedParent) {
				throw new Error(
					"The parent session's delegation lineage changed before child admission.",
				);
			}
			await this.assertActiveCapacity(parentSessionId);
			this.assertSameRunningParentTurn(
				parent,
				parentSessionId,
				parentTurnId,
				"delegation",
			);

			const child = this.pool.create(
				workspace,
				`${provider.label ?? provider.providerId} delegate`,
				true,
			);
			try {
				const delegation = await db.createHlidDelegation({
					id: delegationId,
					parentSessionId,
					parentTurnId,
					parentLabel: parent.manager.getSessionLabel(),
					parentDelegationId: admittedParent?.id ?? null,
					childSessionId: child.sessionId,
					depth,
					task: input.task,
					providerId: input.provider,
					model: model ?? null,
					effort: effort ?? null,
					serviceTier: input.service_tier ?? null,
					workspace,
					permissionMode,
					timeoutSeconds,
					handoff: handoff.summary,
					routineRunId: routineContext?.runId ?? null,
				});
				await db.createSession(
					child.sessionId,
					boundedSessionLabel(input.task),
					model ?? "",
					{
						effort,
						permissionMode,
						agentCwd: workspace,
						providerId: input.provider,
					},
				);
				this.pool.claimDbSessionId(child, child.sessionId);
				await child.manager.setProvider(input.provider, {
					model,
					effort,
					serviceTier: input.service_tier,
					permissionMode,
				});
				this.assertSameRunningParentTurn(
					parent,
					parentSessionId,
					parentTurnId,
					"delegation",
				);
				this.launch(child, delegation, {
					instruction: input.task,
					...handoff.payload,
					...(routineContext ? { routineContext } : {}),
				});
				return delegation;
			} catch (error) {
				this.pool.close(child.sessionId);
				try {
					await db.rollbackHlidDelegationSetup(delegationId, child.sessionId);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"Delegated child setup failed and its durable rollback did not complete.",
					);
				}
				throw error;
			}
		});
	}

	async list(
		parentSessionId: string,
		limit = 50,
	): Promise<
		Array<
			HlidDelegationSnapshot & {
				result_available: boolean;
				error_available: boolean;
			}
		>
	> {
		return (await db.listHlidDelegationsForParent(parentSessionId, limit)).map(
			(delegation) => ({
				...delegation,
				task:
					delegation.task.length <= LIST_TASK_PREVIEW_CHARS
						? delegation.task
						: `${delegation.task.slice(0, LIST_TASK_PREVIEW_CHARS - 1)}…`,
				result_available: delegation.result_text !== null,
				error_available: delegation.error !== null,
				result_text: null,
				error: null,
			}),
		);
	}

	async inspect(
		parentSessionId: string,
		id: string,
	): Promise<HlidDelegationSnapshot> {
		const delegation = await db.getHlidDelegationForParent(id, parentSessionId);
		if (!delegation) {
			throw new Error("Delegated child not found for this parent session.");
		}
		return delegation;
	}

	async wait(
		parentSessionId: string,
		id: string,
		waitSeconds = 60,
	): Promise<HlidDelegationSnapshot> {
		const current = await this.inspect(parentSessionId, id);
		if (isTerminalHlidDelegationStatus(current.status)) return current;
		const active = this.active.get(id);
		if (active) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				active.completion,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, waitSeconds * 1_000);
				}),
			]).finally(() => {
				if (timer !== undefined) clearTimeout(timer);
			});
		}
		return this.inspect(parentSessionId, id);
	}

	/**
	 * Keep the Routine run, lease, and no-overlap boundary alive until every
	 * detached child it owns has settled. The parent provider turn is already
	 * closed while this waits. Looping is intentional: a running child may add
	 * a nested child before its own completion becomes observable.
	 */
	// fallow-ignore-next-line unused-class-member -- SessionRunner holds this manager behind the Routine execution boundary.
	async waitForRoutineRun(runId: string): Promise<HlidDelegationSnapshot[]> {
		for (;;) {
			const completions = [...this.active.values()]
				.filter((run) => run.routineRunId === runId)
				.map((run) => run.completion);
			if (completions.length === 0) break;
			await Promise.allSettled(completions);
		}
		const delegations = await db.listHlidDelegationsForRoutineRun(runId);
		let retired = false;
		for (const delegation of delegations) {
			const entry = this.pool.findByDbSessionId(delegation.child_session_id);
			if (
				entry &&
				this.retireTerminalRuntime(entry, delegation.child_session_id)
			) {
				retired = true;
			}
		}
		if (retired) this.notifyStatusChange();
		return delegations;
	}

	/** Stop every still-active child owned by one unattended Routine run. */
	// fallow-ignore-next-line unused-class-member -- SessionRunner invokes this when a Routine leaves its preapproved envelope.
	async cancelRoutineRun(runId: string): Promise<void> {
		try {
			await this.withHierarchyLock(async () => {
				const delegations = await db.listHlidDelegationsForRoutineRun(runId);
				const ids = new Set(delegations.map((delegation) => delegation.id));
				const roots = delegations.filter(
					(delegation) =>
						!delegation.parent_delegation_id ||
						!ids.has(delegation.parent_delegation_id),
				);
				const errors: unknown[] = [];
				const visited = new Set<string>();
				for (const root of roots) {
					try {
						await this.cancelDelegationTree(root, true, visited);
					} catch (error) {
						collectCancellationError(errors, error);
					}
				}
				// Corrupt historical lineage can contain a closed cycle with no
				// discoverable root. The visited fallback still cancels every row
				// without allowing recursion to loop forever.
				for (const delegation of delegations) {
					if (visited.has(delegation.id)) continue;
					try {
						await this.cancelDelegationTree(delegation, true, visited);
					} catch (error) {
						collectCancellationError(errors, error);
					}
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) {
					throw new AggregateError(
						errors,
						`Failed to fully cancel Routine delegation run ${runId}.`,
					);
				}
			});
		} finally {
			this.notifyStatusChange();
		}
	}

	async steer(
		parentSessionId: string,
		id: string,
		instruction: string,
	): Promise<HlidDelegationSnapshot> {
		const delegation = await this.inspect(parentSessionId, id);
		if (delegation.status !== "running") {
			throw new Error(
				"Only a currently running delegated child can be steered.",
			);
		}
		if (this.cancellationRequested.has(id)) {
			throw new Error(
				"The delegated child is already stopping and cannot be steered.",
			);
		}
		const active = this.active.get(id);
		if (!active) {
			throw new Error(
				"The delegated child is not active in this Hlid process and cannot be steered.",
			);
		}
		const turnId = `delegation-steer-${randomUUID()}`;
		await active.entry.manager.steerActiveTurn(
			instruction,
			(event) => this.emitFor(active.entry, event),
			delegation.child_session_id,
			turnId,
		);
		active.entry.runState.broadcast({
			type: "user_message",
			text: instruction,
			id: turnId,
		});
		active.entry.runState.broadcast({
			type: "turn_steered",
			turn_id: turnId,
			session_id: delegation.child_session_id,
		});
		this.notifyStatusChange();
		return this.inspect(parentSessionId, id);
	}

	private requestActiveCancellation(
		delegationId: string,
		errors: unknown[],
	): void {
		const active = this.active.get(delegationId);
		if (!active) return;
		try {
			active.requestCancel();
		} catch (error) {
			collectCancellationError(errors, error);
		}
		try {
			active.entry.manager.abort();
		} catch (error) {
			collectCancellationError(errors, error);
		}
	}

	private async cancelDelegationTree(
		delegation: HlidDelegationSnapshot,
		root: boolean,
		visited = new Set<string>(),
	): Promise<HlidDelegationSnapshot> {
		if (visited.has(delegation.id)) return delegation;
		visited.add(delegation.id);
		const errors: unknown[] = [];
		let settled = delegation;
		if (delegation.status === "interrupted" && delegation.resumable) {
			try {
				settled =
					(await db.abandonInterruptedHlidDelegation(
						delegation.id,
						root
							? "The parent session cancelled this restart-interrupted child."
							: "An ancestor Hlid delegation cancelled this restart-interrupted child.",
					)) ?? delegation;
			} catch (error) {
				collectCancellationError(errors, error);
			}
		} else if (
			!isTerminalHlidDelegationStatus(delegation.status) &&
			!this.cancellationRequested.has(delegation.id)
		) {
			try {
				settled =
					(await db.updateHlidDelegationProgress(
						delegation.id,
						root
							? "Cancellation requested by parent"
							: "Cancellation requested by ancestor",
					)) ?? delegation;
			} catch (error) {
				collectCancellationError(errors, error);
			}
			if (!isTerminalHlidDelegationStatus(settled.status)) {
				const active = this.active.has(delegation.id);
				if (active) {
					this.cancellationRequested.add(delegation.id);
					this.requestActiveCancellation(delegation.id, errors);
				} else {
					try {
						settled =
							(await db.finishHlidDelegation(delegation.id, {
								status: "cancelled",
								error: root
									? "The parent session cancelled this delegated child."
									: "An ancestor Hlid delegation was cancelled.",
							})) ?? settled;
					} catch (error) {
						collectCancellationError(errors, error);
					}
				}
			}
		}

		let children: HlidDelegationSnapshot[] = [];
		try {
			children = await db.listHlidDelegationsByParentDelegation(delegation.id);
		} catch (error) {
			collectCancellationError(errors, error);
		}
		for (const child of children) {
			try {
				await this.cancelDelegationTree(child, false, visited);
			} catch (error) {
				collectCancellationError(errors, error);
			}
		}
		if (errors.length === 1) {
			throw errors[0];
		}
		if (errors.length > 1) {
			throw new AggregateError(
				errors,
				`Failed to fully cancel Hlid delegation subtree ${delegation.id}.`,
			);
		}
		return settled;
	}

	async cancel(
		parentSessionId: string,
		id: string,
	): Promise<HlidDelegationSnapshot> {
		try {
			return await this.withHierarchyLock(async () => {
				const latest = await this.inspect(parentSessionId, id);
				return this.cancelDelegationTree(latest, true);
			});
		} finally {
			this.notifyStatusChange();
		}
	}

	async resume(
		parentSessionId: string,
		id: string,
		input: ResumeHlidAgentInput,
	): Promise<HlidDelegationSnapshot> {
		return this.withResumeLock(id, () =>
			this.resumeLocked(parentSessionId, id, input),
		);
	}

	private async resumeLocked(
		parentSessionId: string,
		id: string,
		input: ResumeHlidAgentInput,
	): Promise<HlidDelegationSnapshot> {
		const parent = this.requireRunningParent(parentSessionId, "continuation");
		if (parent.manager.isCurrentTurnRoutine()) {
			throw new Error(
				"Routines cannot continue Hlid delegations because their grant-scoped authorization cannot yet be preserved in a child session.",
			);
		}
		const parentTurnId = parent.manager.getCurrentTurnId();
		const current = await this.inspect(parentSessionId, id);
		if (!current.resumable || current.status !== "interrupted") {
			throw new Error(
				"Only a restart-interrupted delegation with remaining attempts can be continued.",
			);
		}
		if (this.active.has(id)) {
			throw new Error("The delegated child already has an active attempt.");
		}
		const parentStatus = parent.manager.getStatus();
		const parentPermissionMode =
			parent.manager.getCurrentTurnPermissionMode() ??
			parentStatus.permission_mode;
		const permissionMode = (input.permission_mode ??
			current.permission_mode) as PermissionMode;
		if (!childPermissionModeAllowed(parentPermissionMode, permissionMode)) {
			throw new Error(
				`A ${parentPermissionMode} parent cannot continue with broader ${permissionMode} permissions.`,
			);
		}
		const provider = this.pool.getProvider(current.provider_id);
		if (!provider) {
			throw new Error(
				`Provider ${current.provider_id} is no longer registered for this continuation.`,
			);
		}
		const providerInfo = (await this.providerCatalog()).find(
			(candidate) => candidate.id === current.provider_id,
		);
		if (!providerInfo) {
			throw new Error(
				`Provider ${current.provider_id} is missing from the current provider catalog.`,
			);
		}
		validateProviderSelection(
			providerInfo,
			{
				task: input.instruction,
				provider: current.provider_id,
				...(current.model ? { model: current.model } : {}),
				...(current.effort ? { effort: current.effort } : {}),
				...(current.service_tier ? { service_tier: current.service_tier } : {}),
				permission_mode: permissionMode,
			},
			permissionMode,
		);
		await assertProviderAvailable(provider);
		const childCwd = await db.getSessionAgentCwd(current.child_session_id);
		const workspace = this.pool.resolveDelegationWorkspace(current.workspace);
		const childWorkspace = childCwd
			? this.pool.resolveDelegationWorkspace(childCwd)
			: null;
		if (!workspace || childWorkspace !== workspace) {
			throw new Error(
				"The delegated child no longer resolves to its recorded configured workspace.",
			);
		}
		const transcript = boundedVisibleTranscript(
			await db.getSessionMessages(
				current.child_session_id,
				undefined,
				VISIBLE_HANDOFF_MESSAGE_LIMIT,
			),
		);
		const handoff = {
			...emptyHandoffSummary(),
			visible_transcript_chars: transcript.length,
		};
		this.assertSameRunningParentTurn(
			parent,
			parentSessionId,
			parentTurnId,
			"continuation",
		);

		let entry = this.pool.findByDbSessionId(current.child_session_id);
		let createdEntry: PoolEntry | null = null;
		if (!entry) {
			const candidate = this.pool.create(
				workspace,
				`${current.provider_id} delegate`,
				true,
			);
			const owner = this.pool.claimDbSessionId(
				candidate,
				current.child_session_id,
			);
			if (owner !== candidate) {
				this.pool.close(candidate.sessionId);
				entry = owner;
			} else {
				entry = candidate;
				createdEntry = candidate;
			}
		}
		if (entry.manager.isRunning()) {
			if (createdEntry) this.pool.close(createdEntry.sessionId);
			throw new Error("The delegated child session is already running.");
		}
		if (entry.manager.getCurrentSessionId() === current.child_session_id) {
			if (entry.manager.getProviderId() !== current.provider_id) {
				if (createdEntry) this.pool.close(createdEntry.sessionId);
				throw new Error(
					"The live delegated child no longer uses its recorded provider.",
				);
			}
			const liveStatus = entry.manager.getStatus();
			if (
				liveStatus.model !== (current.model ?? "") ||
				liveStatus.effort !== (current.effort ?? "")
			) {
				if (createdEntry) this.pool.close(createdEntry.sessionId);
				throw new Error(
					"The live delegated child no longer uses its recorded model and effort.",
				);
			}
		}

		try {
			const resumed = await this.withHierarchyLock(async () => {
				this.assertSameRunningParentTurn(
					parent,
					parentSessionId,
					parentTurnId,
					"continuation",
				);
				const eligible = await this.inspect(parentSessionId, id);
				if (
					!eligible.resumable ||
					eligible.status !== "interrupted" ||
					this.active.has(id)
				) {
					throw new Error(
						"The delegated child is no longer eligible for continuation.",
					);
				}
				await this.assertActiveCapacity(parentSessionId);
				let next: HlidDelegationSnapshot | null;
				try {
					await entry.manager.setProvider(current.provider_id, {
						model: current.model ?? undefined,
						effort: current.effort ?? undefined,
						serviceTier: current.service_tier ?? undefined,
						permissionMode,
						persistSessionSelection: false,
					});
					this.assertSameRunningParentTurn(
						parent,
						parentSessionId,
						parentTurnId,
						"continuation",
					);
					next = await db.resumeHlidDelegation(id, {
						continuationMode: "explicit_new_turn",
						// Preserve the inert historical column; it is not enforced.
						timeoutSeconds: eligible.timeout_seconds,
						permissionMode,
						handoff,
					});
					if (!next) {
						throw new Error(
							"The delegated child is no longer eligible for continuation.",
						);
					}
					try {
						this.assertSameRunningParentTurn(
							parent,
							parentSessionId,
							parentTurnId,
							"continuation",
						);
					} catch (parentError) {
						try {
							const rolledBack = await db.rollbackHlidDelegationResume(
								id,
								eligible,
							);
							if (!rolledBack) {
								throw new Error(
									"The continuation rollback lost its pending lifecycle claim.",
								);
							}
						} catch (rollbackError) {
							throw new AggregateError(
								[parentError, rollbackError],
								"The parent turn ended after continuation admission and its durable rollback did not complete.",
							);
						}
						throw parentError;
					}
				} catch (error) {
					await entry.manager
						.setProvider(current.provider_id, {
							model: current.model ?? undefined,
							effort: current.effort ?? undefined,
							serviceTier: current.service_tier ?? undefined,
							permissionMode: current.permission_mode,
							persistSessionSelection: false,
						})
						.catch(() => {});
					throw error;
				}
				this.launch(entry, next, {
					instruction: input.instruction,
					skillContexts: [],
					relics: [],
					vaultReferences: [],
					workspaceReferences: [],
					...(transcript ? { delegationContext: transcript } : {}),
				});
				return next;
			});
			return resumed;
		} catch (error) {
			if (createdEntry) this.pool.close(createdEntry.sessionId);
			throw error;
		}
	}

	private launch(
		entry: PoolEntry,
		delegation: HlidDelegationSnapshot,
		payload: RunPayload,
	): void {
		let resolveCancel: (() => void) | undefined;
		let cancelRequested = false;
		const cancelled = new Promise<void>((resolve) => {
			resolveCancel = resolve;
		});
		const control: ActiveDelegationRun = {
			entry,
			completion: Promise.resolve(),
			routineRunId: payload.routineContext?.runId ?? null,
			requestCancel: () => {
				cancelRequested = true;
				resolveCancel?.();
			},
		};
		control.completion = this.runDelegation(
			entry,
			delegation,
			payload,
			cancelled,
			() => cancelRequested,
		)
			.catch((error) => {
				console.error(
					`[delegation ${delegation.id}] background lifecycle failed:`,
					error instanceof Error ? error.message : String(error),
				);
			})
			.finally(async () => {
				try {
					const latest = await db.getHlidDelegationForParent(
						delegation.id,
						delegation.parent_session_id,
					);
					if (!latest) {
						this.cancellationRequested.delete(delegation.id);
						return;
					}
					if (!isTerminalHlidDelegationStatus(latest.status)) {
						return;
					}
					this.cancellationRequested.delete(delegation.id);
					// Closing a pool entry retires only its live provider process and
					// control state. The Raven chat, transcript, usage, result, and
					// delegation lineage remain durable in the database.
					if (this.retireTerminalRuntime(entry, latest.child_session_id)) {
						this.notifyStatusChange();
					}
				} catch (error) {
					console.error(
						`[delegation ${delegation.id}] terminal runtime cleanup failed:`,
						error instanceof Error ? error.message : String(error),
					);
				} finally {
					if (this.active.get(delegation.id) === control) {
						this.active.delete(delegation.id);
					}
				}
			});
		this.active.set(delegation.id, control);
		this.notifyStatusChange();
	}

	private async runDelegation(
		entry: PoolEntry,
		delegation: HlidDelegationSnapshot,
		payload: RunPayload,
		cancelled: Promise<void>,
		cancelRequested: () => boolean,
	): Promise<void> {
		let tokenWrite = Promise.resolve();
		let costWrite = Promise.resolve();
		let progressWrite = Promise.resolve();
		let lastProgressText: string | null = null;
		let reportedAttemptTokens = 0;
		let reportedAttemptCost = 0;
		let providerError: string | null = null;
		let startSequence: number | null = null;
		const readAttemptResult = async (): Promise<string | null> => {
			if (startSequence === null) return null;
			return delegatedAssistantText(
				await db.getSessionMessages(
					delegation.child_session_id,
					undefined,
					undefined,
					startSequence,
				),
				startSequence,
			);
		};
		const recordProgress = (text: string | null) => {
			if (!text || text === lastProgressText) return;
			lastProgressText = text;
			progressWrite = queueDelegationPersistence(
				progressWrite,
				delegation.id,
				"progress",
				() => db.updateHlidDelegationProgress(delegation.id, text),
				() => this.notifyStatusChange(),
			);
		};
		try {
			startSequence = await db.getSessionNextMessageSeq(
				delegation.child_session_id,
			);
			const running = await db.markHlidDelegationRunning(delegation.id);
			if (running?.status !== "running") {
				this.notifyStatusChange();
				return;
			}
			this.notifyStatusChange();
			recordProgress("Provider turn running");
			const recordUsage = (event: ServerMessage) => {
				const reportedTokens = reportedQueryTokens(event);
				if (reportedTokens !== null && reportedTokens > reportedAttemptTokens) {
					reportedAttemptTokens = reportedTokens;
					const cumulativeTokens =
						delegation.tokens_used + reportedAttemptTokens;
					tokenWrite = queueDelegationPersistence(
						tokenWrite,
						delegation.id,
						"token",
						() =>
							db.updateHlidDelegationTokens(delegation.id, cumulativeTokens),
						() => this.notifyStatusChange(),
					);
				}
				const reportedCost = reportedQueryCost(event);
				if (reportedCost !== null && reportedCost > reportedAttemptCost) {
					reportedAttemptCost = reportedCost;
					const cumulativeCost = delegation.cost_used + reportedAttemptCost;
					costWrite = queueDelegationPersistence(
						costWrite,
						delegation.id,
						"cost",
						() => db.updateHlidDelegationCost(delegation.id, cumulativeCost),
						() => this.notifyStatusChange(),
					);
				}
			};
			const runQuery = entry.manager.runQuery(
				payload.instruction,
				(event) => {
					recordUsage(event);
					recordProgress(delegationProgressText(event));
					if (event.type === "error") providerError = event.message;
					this.emitFor(entry, event);
				},
				delegation.child_session_id,
				payload.skillContexts,
				payload.relics,
				entry.agentCwd,
				`delegation-${delegation.id}-attempt-${delegation.attempt_count}`,
				undefined,
				undefined,
				undefined,
				payload.vaultReferences,
				payload.routineContext,
				undefined,
				payload.workspaceReferences,
				payload.delegationContext,
				true,
			);
			let runError: unknown;
			let outcome = await Promise.race([
				runQuery.then(
					() => "finished" as const,
					(error) => {
						runError = error;
						return "failed" as const;
					},
				),
				cancelled.then(() => "cancelled" as const),
			]);
			if (cancelRequested()) outcome = "cancelled";

			if (outcome === "cancelled") {
				entry.manager.abort();
				recordProgress("Stopping cancelled provider turn");
				await settleAfterAbort(runQuery);
				await Promise.all([tokenWrite, costWrite, progressWrite]);
				const resultText = await readAttemptResult().catch(() => null);
				await db.finishHlidDelegation(delegation.id, {
					status: "cancelled",
					resultText,
					error:
						"The parent session cancelled this delegated child or one of its ancestors.",
				});
				await db.recordHlidDelegationPartialResult(delegation.id, resultText);
				return;
			}
			if (outcome === "failed") throw runError;

			await tokenWrite;
			await costWrite;
			await progressWrite;
			const resultText = await readAttemptResult();
			if (entry.manager.getStatus().state === "error") {
				await db.finishHlidDelegation(delegation.id, {
					status: "failed",
					resultText,
					error:
						providerError ??
						"The delegated provider session ended in an error state.",
				});
			} else if (!resultText) {
				await db.finishHlidDelegation(delegation.id, {
					status: "failed",
					error:
						"The delegated provider completed without an assistant result.",
				});
			} else {
				await db.finishHlidDelegation(delegation.id, {
					status: "completed",
					resultText,
				});
			}
		} catch (error) {
			const resultText = await readAttemptResult().catch(() => null);
			if (cancelRequested()) {
				await db.finishHlidDelegation(delegation.id, {
					status: "cancelled",
					resultText,
					error:
						"The parent session cancelled this delegated child or one of its ancestors.",
				});
			} else {
				await db.finishHlidDelegation(delegation.id, {
					status: "failed",
					resultText,
					error:
						providerError ??
						(error instanceof Error ? error.message : String(error)),
				});
			}
		} finally {
			await Promise.all([tokenWrite, costWrite, progressWrite]);
			this.notifyStatusChange();
		}
	}
}
