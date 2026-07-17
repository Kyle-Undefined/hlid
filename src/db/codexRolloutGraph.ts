import type { ParsedCodexRollout } from "./codexUsageRepair";

type CodexChildTurn = {
	startedAtMs: number;
	endedAtMs: number;
	childIds: Set<string>;
};

export function codexChildrenByParent(
	rollouts: Map<string, ParsedCodexRollout>,
): Map<string, string[]> {
	const children = new Map<string, string[]>();
	for (const rollout of rollouts.values()) {
		if (!rollout.parentThreadId) continue;
		const ids = children.get(rollout.parentThreadId) ?? [];
		ids.push(rollout.threadId);
		children.set(rollout.parentThreadId, ids);
	}
	return children;
}

export function codexDirectChildIds(args: {
	owner: Pick<ParsedCodexRollout, "threadId">;
	turn: CodexChildTurn;
	rollouts: Map<string, ParsedCodexRollout>;
	children: Map<string, string[]>;
}): string[] {
	const ids = new Set(args.turn.childIds);
	for (const id of args.children.get(args.owner.threadId) ?? []) {
		const child = args.rollouts.get(id);
		if (
			child &&
			child.createdAtMs >= args.turn.startedAtMs - 1_000 &&
			child.createdAtMs <= args.turn.endedAtMs + 1_000
		) {
			ids.add(id);
		}
	}
	return [...ids];
}
