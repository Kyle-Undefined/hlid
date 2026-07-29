import { describe, expect, it } from "vitest";
import type {
	SessionAttentionBucket,
	SessionStatusEntry,
} from "../server/protocol";
import {
	collapsibleDelegatedDescendantIds,
	withDelegatedAttentionRollups,
} from "./delegationAttention";

function status(
	id: string,
	bucket: SessionAttentionBucket,
	parent: string | null = null,
): SessionStatusEntry {
	return {
		session_id: `pool-${id}`,
		agent_cwd: "/work/project",
		agent_name: id,
		state:
			bucket === "working"
				? "running"
				: bucket === "needs_attention"
					? "error"
					: "idle",
		model: "test",
		hasPendingPermissions: bucket === "needs_attention",
		hasDbSession: true,
		db_session_id: id,
		delegation_parent_session_id: parent,
		attention: {
			bucket,
			reason:
				bucket === "needs_attention"
					? "permission"
					: bucket === "working"
						? "provider_turn"
						: bucket === "queued"
							? "queued_prompt"
							: "ready",
			since: id.length * 100,
			last_activity_at: id.length * 1_000,
			queue_count: bucket === "queued" ? 1 : 0,
			pending_count: bucket === "needs_attention" ? 1 : 0,
		},
	};
}

describe("delegated session attention", () => {
	it("rolls three live levels up without replacing stronger direct attention", () => {
		const [root, child, grandchild] = withDelegatedAttentionRollups([
			status("root", "recent"),
			status("child", "working", "root"),
			status("grandchild", "needs_attention", "child"),
		]);

		expect(root).toMatchObject({
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 1,
				descendant_count: 2,
				needs_attention_count: 1,
				working_count: 1,
			},
		});
		expect(child).toMatchObject({
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 1,
				descendant_count: 1,
			},
		});
		expect(grandchild?.attention?.reason).toBe("permission");
	});

	it("terminates malformed cycles and ignores missing live ancestors", () => {
		const result = withDelegatedAttentionRollups([
			status("a", "working", "b"),
			status("b", "queued", "a"),
			status("orphan", "needs_attention", "missing"),
		]);

		expect(result[0]?.delegated_attention?.descendant_count).toBe(1);
		expect(result[1]?.delegated_attention?.descendant_count).toBe(1);
		expect(result[2]?.delegated_attention).toBeUndefined();
	});

	it("bridges a missing delegated process through persisted lineage without projecting it", () => {
		const result = withDelegatedAttentionRollups(
			[
				status("root", "recent"),
				status("grandchild", "needs_attention", "missing-child"),
			],
			new Map([
				["grandchild", "missing-child"],
				["missing-child", "root"],
			]),
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			db_session_id: "root",
			attention: {
				bucket: "needs_attention",
				reason: "delegated_child_attention",
			},
			delegated_attention: {
				direct_count: 0,
				descendant_count: 1,
				needs_attention_count: 1,
			},
		});
		expect(
			result.some((entry) => entry.db_session_id === "missing-child"),
		).toBe(false);
	});

	it("merges mixed durable lifecycle counts through nested live attention", () => {
		const result = withDelegatedAttentionRollups(
			[status("root", "recent"), status("child", "working", "root")],
			new Map(),
			new Map([
				[
					"root",
					{
						direct_count: 3,
						descendant_count: 4,
						waiting_count: 1,
						completed_count: 1,
						failed_count: 1,
						total_tokens: 1_250,
						total_cost: 2.5,
						elapsed_duration_seconds: 150,
						last_activity_at: 9_000,
					},
				],
				[
					"child",
					{
						direct_count: 1,
						descendant_count: 1,
						waiting_count: 0,
						completed_count: 1,
						failed_count: 0,
						total_tokens: 300,
						total_cost: 0.75,
						elapsed_duration_seconds: 45,
						last_activity_at: 8_000,
					},
				],
			]),
		);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			attention: {
				bucket: "working",
				reason: "delegated_child_working",
			},
			delegated_attention: {
				direct_count: 3,
				descendant_count: 4,
				waiting_count: 1,
				completed_count: 1,
				failed_count: 1,
				total_tokens: 1_250,
				total_cost: 2.5,
				elapsed_duration_seconds: 150,
				working_count: 1,
				last_activity_at: 9_000,
			},
		});
		expect(result[1]).toMatchObject({
			delegated_attention: {
				direct_count: 1,
				descendant_count: 1,
				completed_count: 1,
				total_tokens: 300,
				total_cost: 0.75,
				elapsed_duration_seconds: 45,
				working_count: 0,
			},
		});
	});

	it("attaches terminal-only lifecycle counts without inventing child status rows", () => {
		const [root] = withDelegatedAttentionRollups(
			[status("root", "recent")],
			new Map(),
			new Map([
				[
					"root",
					{
						direct_count: 2,
						descendant_count: 3,
						waiting_count: 0,
						completed_count: 2,
						failed_count: 1,
						last_activity_at: 12_000,
					},
				],
			]),
		);

		expect(root?.attention).toMatchObject({
			bucket: "recent",
			reason: "ready",
		});
		expect(root?.delegated_attention).toMatchObject({
			direct_count: 2,
			descendant_count: 3,
			waiting_count: 0,
			completed_count: 2,
			failed_count: 1,
			total_tokens: 0,
			total_cost: 0,
			elapsed_duration_seconds: 0,
			needs_attention_count: 0,
			working_count: 0,
			queued_count: 0,
		});
	});

	it("collapses only descendants with a surviving ancestor representative", () => {
		expect(
			collapsibleDelegatedDescendantIds(
				[
					{ id: "root", parentId: null },
					{ id: "child", parentId: "root" },
					{ id: "grandchild", parentId: "child" },
					{ id: "orphan", parentId: "missing" },
					{ id: "cycle-a", parentId: "cycle-b" },
					{ id: "cycle-b", parentId: "cycle-a" },
				],
				new Set(["root"]),
			),
		).toEqual(new Set(["child", "grandchild"]));
	});
});
