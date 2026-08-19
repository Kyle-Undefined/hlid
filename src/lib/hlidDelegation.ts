export const HLID_DELEGATION_MAX_DEPTH = 3;
export const HLID_DELEGATION_MAX_ATTEMPTS = 3;
export const HLID_DELEGATION_MAX_HANDOFF_CHARS = 40_000;
export const HLID_DELEGATION_MAX_RESULT_CHARS = 12_000;
export const HLID_DELEGATION_MAX_ERROR_CHARS = 2_000;
export const HLID_DELEGATION_MAX_PROGRESS_CHARS = 500;
export const HLID_DELEGATION_MAX_TASK_CHARS = 20_000;
export const HLID_DELEGATION_MAX_TASK_PREVIEW_CHARS = 2_000;
export const HLID_DELEGATION_MAX_ACTIVE_PER_PARENT = 4;
export const HLID_DELEGATION_MAX_ACTIVE_GLOBAL = 12;
export const HLID_DELEGATION_CONTROL_OWNERSHIP_ERROR =
	"This Raven session is owned by an active or resumable Hlid delegation. Use the delegation controls from its parent session.";

export const HLID_DELEGATION_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	/** Historical read compatibility for delegations created with lifecycle timeouts. */
	"timed_out",
	"interrupted",
	"cancelled",
	/** Historical read compatibility for delegations created with orchestration caps. */
	"budget_exhausted",
] as const;

export type HlidDelegationStatus = (typeof HLID_DELEGATION_STATUSES)[number];

export const HLID_DELEGATION_CONTINUATION_MODES = [
	"initial",
	"explicit_new_turn",
] as const;

export type HlidDelegationContinuationMode =
	(typeof HLID_DELEGATION_CONTINUATION_MODES)[number];

export const HLID_DELEGATION_WORKSPACE_MODES = ["shared", "worktree"] as const;
export type HlidDelegationWorkspaceMode =
	(typeof HLID_DELEGATION_WORKSPACE_MODES)[number];

export const HLID_DELEGATION_WORKTREE_STATES = [
	"none",
	"active",
	"retained",
	"cleaned",
] as const;
export type HlidDelegationWorktreeState =
	(typeof HLID_DELEGATION_WORKTREE_STATES)[number];

export type HlidDelegationHandoffSummary = {
	visible_transcript_chars: number;
	selected_skills: number;
	selected_relics: number;
	vault_references: number;
	workspace_references: number;
};

export type HlidDelegationSnapshot = {
	id: string;
	parent_session_id: string;
	parent_turn_id: string | null;
	parent_label: string | null;
	parent_delegation_id: string | null;
	routine_run_id?: string | null;
	child_session_id: string;
	depth: number;
	task: string;
	provider_id: string;
	model: string | null;
	effort: string | null;
	service_tier: string | null;
	workspace: string;
	workspace_mode: HlidDelegationWorkspaceMode;
	execution_workspace: string;
	worktree_branch: string | null;
	worktree_base_commit: string | null;
	worktree_state: HlidDelegationWorktreeState;
	permission_mode: string;
	/** Historical inert field retained for existing database and API snapshots. */
	timeout_seconds: number;
	/** Historical read compatibility; new delegations persist null. */
	token_budget: number | null;
	tokens_used: number;
	/** Historical read compatibility; new delegations persist null. */
	cost_budget: number | null;
	cost_used: number;
	attempt_count: number;
	continuation_mode: HlidDelegationContinuationMode;
	handoff: HlidDelegationHandoffSummary;
	status: HlidDelegationStatus;
	started_at: number;
	updated_at: number;
	ended_at: number | null;
	result_text: string | null;
	error: string | null;
	progress_text: string | null;
	open_url: string;
	complete: boolean;
	resumable: boolean;
};

export function isHlidDelegationControlOwned(
	delegation:
		| Pick<HlidDelegationSnapshot, "status" | "resumable">
		| null
		| undefined,
): boolean {
	return (
		delegation?.status === "pending" ||
		delegation?.status === "running" ||
		(delegation?.status === "interrupted" && delegation.resumable)
	);
}

export function isTerminalHlidDelegationStatus(
	status: HlidDelegationStatus,
): boolean {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "timed_out" ||
		status === "interrupted" ||
		status === "cancelled" ||
		status === "budget_exhausted"
	);
}

export function isResumableHlidDelegation(
	status: HlidDelegationStatus,
	attemptCount: number,
): boolean {
	return (
		status === "interrupted" && attemptCount < HLID_DELEGATION_MAX_ATTEMPTS
	);
}
