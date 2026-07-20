import type { ParsedCodexRollout } from "./codexUsageRepair";

type CodexChildTurn = {
	startedAtMs: number;
	endedAtMs: number;
	childIds: Set<string>;
};

type PendingCodexChild = {
	id: string;
	startMs: number;
	endMs: number;
};

type CodexChildRollout = Pick<ParsedCodexRollout, "createdAtMs" | "threadId">;

export type CodexChildTurnEvidence<TRollout, TTurn extends CodexChildTurn> = {
	rollout: TRollout;
	turn: TTurn;
};

export type ExpandedCodexChildTurns<TRollout, TTurn extends CodexChildTurn> = {
	turns: Array<CodexChildTurnEvidence<TRollout, TTurn>>;
	threadIds: string[];
	turnKeys: string[];
	exact: boolean;
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

export function codexDirectChildIds<TRollout extends CodexChildRollout>(args: {
	owner: Pick<TRollout, "threadId">;
	turn: CodexChildTurn;
	rollouts: Map<string, TRollout>;
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

export function expandCodexChildTurns<
	TTurn extends CodexChildTurn & { id: string },
	TRollout extends CodexChildRollout,
>(args: {
	owner: TRollout;
	ownerTurn: TTurn;
	rollouts: Map<string, TRollout>;
	children: Map<string, string[]>;
	selectTurns: (
		rollout: TRollout,
		pending: PendingCodexChild,
	) => { turns: TTurn[]; exact: boolean };
}): ExpandedCodexChildTurns<TRollout, TTurn> {
	const queue: PendingCodexChild[] = codexDirectChildIds({
		owner: args.owner,
		turn: args.ownerTurn,
		rollouts: args.rollouts,
		children: args.children,
	}).map((id) => ({
		id,
		startMs: args.ownerTurn.startedAtMs,
		endMs: args.ownerTurn.endedAtMs,
	}));
	const selected: Array<CodexChildTurnEvidence<TRollout, TTurn>> = [];
	const threadIds = new Set<string>();
	const turnKeys = new Set<string>();
	let exact = true;
	while (queue.length > 0) {
		const pending = queue.shift();
		if (!pending) continue;
		const rollout = args.rollouts.get(pending.id);
		if (!rollout) {
			exact = false;
			continue;
		}
		const selection = args.selectTurns(rollout, pending);
		if (selection.turns.length === 0) {
			if (!selection.exact) exact = false;
			continue;
		}
		threadIds.add(rollout.threadId);
		for (const turn of selection.turns) {
			const key = `${rollout.threadId}:${turn.id}`;
			if (turnKeys.has(key)) continue;
			turnKeys.add(key);
			selected.push({ rollout, turn });
			for (const id of codexDirectChildIds({
				owner: rollout,
				turn,
				rollouts: args.rollouts,
				children: args.children,
			})) {
				queue.push({ id, startMs: turn.startedAtMs, endMs: turn.endedAtMs });
			}
		}
	}
	return {
		turns: selected,
		threadIds: [...threadIds],
		turnKeys: [...turnKeys],
		exact,
	};
}
