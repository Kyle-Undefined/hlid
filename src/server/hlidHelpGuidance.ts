import type { HlidHelpTopic } from "./hlidHelp";

export const TOPIC_GUIDANCE: Record<HlidHelpTopic, string[]> = {
	overview: [
		"Use focused help topics instead of loading a cross-provider manual.",
		"Treat unavailable capabilities as unavailable; do not simulate provider-native behavior.",
	],
	references: [
		"Hlid @ references select exact Vault notes or Workspace files.",
		"Do not expand links, backlinks, embeds, attachments, imports, neighboring files, directories, or Git history unless the user asks.",
		"Use hlid_obsidian for supported Vault operations instead of shell or filesystem access.",
	],
	permissions: [
		"Hlid approval policy and provider-native permissions are separate layers.",
		"A tool being available does not imply a mutation is pre-approved.",
		"Use the active session policy and preserve provider-native safety boundaries.",
	],
	sessions: [
		"Rename and archive are Hlid-owned metadata operations and stay outside provider transcripts.",
		"Exact forks are exposed only when the provider preserves native hidden context.",
		"Archive is reversible; delete follows retention rules.",
	],
	context: [
		"Hlid adds only the operating brief and the exact instructions, references, skills, attachments, or plan guidance selected for the turn.",
		"Use Raven /context to inspect the persisted receipt: character and token estimates, context blocks, exact references, attachment delivery, provider handoff size, and deferred tool counts.",
		"The receipt is Hlid metadata stored outside the visible provider transcript. Inspecting it does not send another prompt to the provider.",
		"Claude and Codex defer Hlid and Obsidian tool schemas until discovery. ACP receives registered MCP tool schemas because its current transport has no equivalent deferred-loading contract.",
	],
	plans_review: [
		"Provider-native planning remains native; Hlid owns the shared presentation and decision lifecycle.",
		"A completed plan can be approved for implementation, returned with requested revisions, or cancelled.",
		"Optional HTML plans are written to one Hlid-owned path, ingested into a sandboxed review surface, and remain separate from ordinary HTML reports published to Relics.",
		"Provider-native working-tree review is a separate provider activity and must not be presented as plan approval.",
	],
	workflows: [
		"Dynamic Workflows are Claude-native.",
		"Hlid owns their Raven presentation, parent-child correlation, lifecycle controls, and retained transcript state.",
	],
	orchestration: [
		"Choose the exact provider ID and optional model, effort, and model service-tier values from orchestrationTargets. This is a bounded snapshot of the live provider catalog; do not guess unavailable or truncated entries.",
		"For Codex user-input children, set permission_mode=plan: request_user_input is unavailable in default mode. A question-only turn does not enter plan review without a real plan.",
		"Use provider-native same-provider subagents when a durable Raven child is unnecessary. Hlid delegation is an explicit ordinary child session.",
		"Delegation is bounded to three levels, four active direct children per parent, and twelve active delegated children across Hlid. The ordinary session pool has its own separate capacity. Children default to the parent workspace; cwd may select only the exact configured vault or a registered workspace. Permissions must be inherited or narrower.",
		"Visible transcript, selected skills, durable Relics, and exact current-turn Vault or Workspace references are empty by default and require explicit handoff switches. Hlid never expands an exact selection, borrows an ordinary upload, or claims hidden provider context moved.",
		"Hlid imposes no elapsed-time or inactivity cap on delegated work because cross-provider silence is not proof that a child is unresponsive. New runs do not accept timeout_seconds, token_budget, or cost_budget, and do not transition automatically to timed_out or budget_exhausted. Historical snapshots may retain inert timeout_seconds, token_budget, or cost_budget values and timed_out or budget_exhausted states for compatibility. Provider availability is checked before launch. Native launch, transport, or process failures settle the child naturally. Explicit cancel_hlid_agent is the way to stop work. Hlid passively records provider-reported token usage and available cost without using either as a lifecycle cap.",
		"steer_hlid_agent uses only the active provider's native same-turn steering primitive. Unsupported providers return unavailable; Hlid does not substitute cancellation or a queued fresh turn.",
		"cancel_hlid_agent requests cancellation of the addressed child and every active nested descendant immediately. Hlid retains provider control, delegation ownership, and active capacity until each provider turn settles, then persists terminal cancelled state. For a resumable restart-interrupted child with no active provider turn, cancel explicitly abandons continuation and marks it cancelled immediately while retaining its Raven transcript and Ledger provenance. Closing that interrupted child from the live-session surface has the same abandonment semantics. A terminal ancestor stays terminal while active descendants stop. After restart, active work becomes interrupted instead of being replayed.",
		"Children remain independent after the parent turn finishes, the browser disconnects, or the parent is archived. Those events do not imply cancellation. Deleting a parent is blocked while delegated descendants remain; use cancel_hlid_agent when the work should stop.",
		"Parent rollups retain bounded durable waiting, completed, and failed descendant counts. Completed and failed child sessions remain ordinary Raven and Ledger history; Hlid does not present them as live provider processes.",
		"Scheduled Routines may delegate after the delegation call passes both the reviewed Routine envelope and Umbod. Detached descendants share the exact per-run Routine context, grant-use counters, and action-required callback while the Routine run owns their lifecycle after its parent provider turn closes. A late unmatched action pauses the Routine and cancels its remaining children. Restart-interrupted Routine children cannot be continued outside the ended run.",
		"resume_hlid_agent starts an explicit new turn only for a restart-interrupted non-Routine child with a remaining attempt and from a live running parent turn. It revalidates the recorded configured workspace plus provider, model, effort, and service tier, enforces inherited or narrower permissions and active-capacity limits, and supplies bounded visible child transcript context without inheriting references or Relics.",
		"delegate_hlid_agent returns immediately and its parent card retains a bounded current step. Use list_hlid_agents for compact lifecycle and result-availability snapshots; use inspect_hlid_agent or wait_hlid_agent for bounded active progress and terminal result, partial result, and error details.",
	],
	goals: [
		"Goals are Codex-native state, not prompt conventions.",
		"Hlid reflects provider goal status, usage, pause, resume, update, and clear operations.",
	],
	relics: [
		"Publish durable agent-generated reports or outputs to Relics.",
		"Do not publish ordinary source files or use Relics as a substitute for workspace edits.",
	],
	project_preview: [
		"Start one session-scoped web server, then inspect or interact through Hlid's managed Preview browser.",
		"Preview tools are bounded to the active workspace, session, and preview-local routes.",
	],
	mcp: [
		"MCP inventory and controls are provider-scoped.",
		"Do not infer that identical server names imply identical provider behavior or configuration.",
	],
	skills_extensions: [
		"Selected Vault, library, or provider skills are prompt context for the current turn; package instructions remain the package author's contract.",
		"Hlid-managed skills are staged and reviewed before installation, stored in Hlid's managed library, and can be selected in Raven or Watch.",
		"Claude and Codex extensions remain provider-native packages with their own marketplaces, scopes, enablement, executable behavior, and update limits.",
		"Do not flatten skills, extensions, MCP servers, commands, hooks, or agents into one universal plugin model.",
	],
	api: [
		"Use hlid_api for bounded, live endpoint discovery instead of loading or memorizing the full HTTP catalog.",
		"The data and UI listeners can use different ports. Follow the live base URLs returned by hlid_api.",
		"GET endpoints are generally observational. POST, PATCH, and DELETE endpoints can mutate state and remain subject to active permissions and endpoint-specific requirements.",
		"Prefer a curated Hlid tool when one exists; use the HTTP API for direct Hlid integration and capabilities without a dedicated tool.",
	],
	computer_use: [
		"Windows Computer Use is Hlid-owned delegation into a fresh Windows-native Codex worker, not a command executed inside the current WSL or provider process.",
		"Availability requires a Windows host, native Codex CLI, and the installed and enabled Computer Use plugin. Hlid and native per-application approvals both remain active.",
		"The worker closes after the task while its progress, usage, duration, and estimated cost remain associated with Hlid.",
	],
	voice_audio: [
		"Local Whisper dictation is user input and is separate from provider-native audio turns or Raven Live.",
		"Local neural read aloud is host-generated output. It uses its own downloaded model and runtime, independently of Whisper input and provider-native audio.",
		"Native Codex audio requires an audio-capable selected model. Raven Live additionally requires the Hlid feature flag and provider backend support.",
		"Do not claim audio or realtime availability from the provider name alone; use the live capability state.",
	],
	providers: [
		"Provider-native operations remain native and capability-gated.",
		"Never present transcript replay as an exact fork or a prompt convention as a structured provider operation.",
		"When a Raven session changes provider, Hlid can supply a bounded visible-transcript handoff. Native hidden context does not cross that boundary.",
		"Compaction and working-tree review use structured provider activity only when the active provider advertises support.",
	],
};
