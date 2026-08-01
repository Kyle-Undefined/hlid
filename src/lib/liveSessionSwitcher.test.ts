import { describe, expect, it } from "vitest";
import type { SessionRow } from "#/db";
import type { SessionStatusEntry } from "#/server/protocol";
import {
	deriveLiveSessionSwitcherRows,
	derivePersistedRecentSessionRows,
	liveDelegationRollupLabel,
	liveDelegationUsageLabel,
	liveSessionContext,
	liveSessionQueueLabel,
	liveSessionReasonLabel,
	liveSessionState,
	liveSessionStateLabel,
	liveSessionToggleTone,
	summarizeLiveSessionAttention,
} from "./liveSessionSwitcher";

function session(
	id: string,
	overrides: Partial<SessionStatusEntry> = {},
): SessionStatusEntry {
	return {
		session_id: `pool-${id}`,
		agent_cwd: `/work/${id}`,
		agent_name: id,
		state: "idle",
		provider_id: "claude",
		model: "sonnet",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: `chat-${id}`,
		...overrides,
	};
}

function persistedSession(
	id: string,
	overrides: Partial<SessionRow> = {},
): SessionRow {
	return {
		id,
		label: id,
		model: "sonnet",
		started_at: 1,
		ended_at: 2,
		query_count: 1,
		total_cost: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cache_read_tokens: 0,
		total_cache_creation_tokens: 0,
		total_turns: 1,
		...overrides,
	};
}

describe("deriveLiveSessionSwitcherRows", () => {
	it("excludes pool placeholders without a real database chat", () => {
		expect(
			deriveLiveSessionSwitcherRows([
				session("unused", {
					hasDbSession: false,
					db_session_id: null,
				}),
				session("inconsistent", {
					hasDbSession: true,
					db_session_id: null,
				}),
				session("ready"),
			]).map((row) => row.dbSessionId),
		).toEqual(["chat-ready"]);
	});

	it("classifies attention, active work, and live idle sessions", () => {
		expect(
			liveSessionState(
				session("approval", {
					state: "running",
					hasPendingPermissions: true,
				}),
			),
		).toBe("needs_attention");
		expect(liveSessionState(session("error", { state: "error" }))).toBe(
			"needs_attention",
		);
		expect(liveSessionState(session("running", { state: "running" }))).toBe(
			"working",
		);
		expect(liveSessionState(session("idle"))).toBe("recent");
	});

	it("orders attention, working, sleeping, queued, and recent while preserving pool order within groups", () => {
		const rows = deriveLiveSessionSwitcherRows([
			session("ready-a"),
			session("working-a", { state: "running" }),
			session("waiting-a", { hasPendingPermissions: true }),
			session("sleeping", {
				state: "running",
				attention: {
					bucket: "sleeping",
					reason: "usage_sleep",
					since: 1,
					last_activity_at: 1,
					queue_count: 1,
					pending_count: 0,
					sleep_until: 1_784_060_475,
				},
			}),
			session("queued", {
				attention: {
					bucket: "queued",
					reason: "queued_prompt",
					since: 1,
					last_activity_at: 1,
					queue_count: 2,
					pending_count: 0,
				},
			}),
			session("working-b", { state: "running" }),
			session("ready-b"),
		]);

		expect(rows.map((row) => row.dbSessionId)).toEqual([
			"chat-waiting-a",
			"chat-working-a",
			"chat-working-b",
			"chat-sleeping",
			"chat-queued",
			"chat-ready-a",
			"chat-ready-b",
		]);
	});

	it("orders pins within a bucket without letting a pin outrank urgent work", () => {
		const rows = deriveLiveSessionSwitcherRows([
			session("ready"),
			session("working", { state: "running" }),
			session("pinned-ready", { pinned: true }),
			session("pinned-working", { state: "running", pinned: true }),
			session("approval", { hasPendingPermissions: true }),
		]);
		expect(rows.map((row) => row.dbSessionId)).toEqual([
			"chat-approval",
			"chat-pinned-working",
			"chat-working",
			"chat-pinned-ready",
			"chat-ready",
		]);
	});

	it("adds workspace context only for ambiguous labels and keeps child provenance", () => {
		const rows = deriveLiveSessionSwitcherRows([
			session("one", {
				agent_cwd: "/work/alpha",
				lastLabel: "Review",
				fork_parent_session_id: "source",
				fork_parent_label: "Original",
				fork_kind: "exact",
			}),
			session("two", {
				agent_cwd: "C:\\work\\beta",
				lastLabel: "Review",
				delegation_parent_session_id: "parent",
				delegation_parent_label: "Parent task",
			}),
			session("three", { lastLabel: "Unique" }),
		]);
		expect(rows.map((row) => row.workspaceLabel)).toEqual([
			"alpha",
			"beta",
			null,
		]);
		expect(rows[0]?.forkLabel).toBe("Fork of Original");
		expect(rows[1]?.delegationLabel).toBe("Delegated from Parent task");
	});
});

describe("live session presentation", () => {
	it("gives attention precedence in the aggregate toggle tone", () => {
		const recent = deriveLiveSessionSwitcherRows([session("ready")]);
		const working = deriveLiveSessionSwitcherRows([
			session("ready"),
			session("working", { state: "running" }),
		]);
		const waiting = deriveLiveSessionSwitcherRows([
			session("working", { state: "running" }),
			session("waiting", { state: "error" }),
		]);

		expect(liveSessionToggleTone([])).toBe("empty");
		expect(liveSessionToggleTone(recent)).toBe("recent");
		expect(liveSessionToggleTone(working)).toBe("working");
		expect(liveSessionToggleTone(waiting)).toBe("needs_attention");
	});

	it("uses server reasons, queue counts, and shared group labels", () => {
		const queued = session("queued", {
			attention: {
				bucket: "working",
				reason: "provider_turn",
				since: 1,
				last_activity_at: 2,
				queue_count: 3,
				pending_count: 0,
			},
		});
		expect(liveSessionStateLabel("needs_attention")).toBe("Needs attention");
		expect(liveSessionStateLabel("sleeping")).toBe("Sleeping");
		expect(liveSessionReasonLabel(queued)).toBe("Working");
		expect(liveSessionQueueLabel(queued)).toBe("3 queued");
	});

	it("keeps provider, model, and terminal context compact", () => {
		expect(
			liveSessionContext(
				session("terminal", {
					provider_id: "codex",
					model: "gpt-5.6-sol",
					mode: "terminal",
				}),
			),
		).toBe("codex · gpt-5.6-sol · terminal");
		expect(
			liveSessionContext(
				session("workspace", {
					provider_id: "codex",
					model: "gpt-5.6-sol",
				}),
				"hlid",
			),
		).toBe("hlid · codex · gpt-5.6-sol");
	});

	it("summarizes the same database-backed rows used by Raven", () => {
		expect(
			summarizeLiveSessionAttention([
				session("attention", { state: "error" }),
				session("working", { state: "running" }),
				session("queued", {
					attention: {
						bucket: "queued",
						reason: "queued_prompt",
						since: 1,
						last_activity_at: 1,
						queue_count: 1,
						pending_count: 0,
					},
				}),
				session("recent"),
				session("placeholder", {
					hasDbSession: false,
					db_session_id: null,
				}),
			]),
		).toEqual({
			total: 4,
			needsAttention: 1,
			working: 1,
			sleeping: 0,
			queued: 1,
			recent: 1,
		});
	});

	it("labels durable restart interruption without calling it a provider error", () => {
		expect(
			liveSessionReasonLabel(
				session("interrupted", {
					durable_only: true,
					attention: {
						bucket: "needs_attention",
						reason: "delegation_interrupted",
						since: 1,
						last_activity_at: 1,
						queue_count: 0,
						pending_count: 0,
					},
				}),
			),
		).toBe("Restart interrupted");
	});

	it("formats delegated descendant rollups compactly", () => {
		expect(
			liveDelegationRollupLabel(
				session("parent", {
					delegated_attention: {
						direct_count: 2,
						descendant_count: 3,
						waiting_count: 0,
						completed_count: 0,
						failed_count: 0,
						needs_attention_count: 1,
						working_count: 2,
						queued_count: 0,
						recent_count: 0,
						leading_bucket: "needs_attention",
						since: 1,
						last_activity_at: 2,
					},
				}),
			),
		).toBe("3 delegated · 1 needs you · 2 working");
	});

	it("formats durable lifecycle counts without expanding descendant detail", () => {
		const parent = session("parent", {
			delegated_attention: {
				direct_count: 3,
				descendant_count: 5,
				waiting_count: 1,
				completed_count: 2,
				failed_count: 1,
				needs_attention_count: 0,
				working_count: 1,
				queued_count: 0,
				recent_count: 0,
				leading_bucket: "working",
				since: 1,
				last_activity_at: 2,
				total_tokens: 1_234_567,
				total_cost: 1.234,
				elapsed_duration_seconds: 7_441,
			},
		});
		expect(liveDelegationRollupLabel(parent)).toBe(
			"5 delegated · 1 working · 1 waiting · 2 completed · 1 failed",
		);
		expect(liveDelegationUsageLabel(parent)).toBe(
			"1.2m tokens · $1.23 · 2h 4m elapsed",
		);
	});

	it("omits delegation usage totals from older status snapshots", () => {
		expect(
			liveDelegationUsageLabel(
				session("parent", {
					delegated_attention: {
						direct_count: 1,
						descendant_count: 1,
						waiting_count: 0,
						completed_count: 1,
						failed_count: 0,
						needs_attention_count: 0,
						working_count: 0,
						queued_count: 0,
						recent_count: 0,
						leading_bucket: "recent",
						since: 1,
						last_activity_at: 2,
					},
				}),
			),
		).toBeNull();
	});
});

describe("persisted Recent presentation", () => {
	it("keeps pins visible, removes actionable live duplicates, and shows provenance", () => {
		const rows = derivePersistedRecentSessionRows(
			[
				persistedSession("new", {
					label: "Review",
					agent_cwd: "/work/new",
					ended_at: 20,
				}),
				persistedSession("pinned", {
					label: "Review",
					agent_cwd: "/work/pinned",
					pinned: 1,
					ended_at: 10,
					fork_parent_session_id: "source",
					fork_parent_label: "Original",
				}),
				persistedSession("working", { ended_at: 30 }),
			],
			[
				session("working", {
					state: "running",
					db_session_id: "working",
				}),
			],
		);
		expect(rows.map((row) => row.session.id)).toEqual(["pinned", "new"]);
		expect(rows.map((row) => row.workspaceLabel)).toEqual(["pinned", "new"]);
		expect(rows[0]?.forkLabel).toBe("Fork of Original");
	});
});
