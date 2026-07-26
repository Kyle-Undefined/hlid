/**
 * Move persisted steering prompts immediately before the assistant response
 * they joined. The provider still owns one native turn, but Raven renders the
 * added user direction as part of that turn instead of after its completed
 * response.
 */
export function orderSteeredTranscript<T extends object>(
	items: readonly T[],
	selectors: {
		role: (item: T) => string;
		sequence: (item: T) => number | undefined;
		steerTargetSequence: (item: T) => number | null | undefined;
	},
): T[] {
	const assistantTargets = new Set<number>();
	for (const item of items) {
		if (selectors.role(item) !== "assistant") continue;
		const sequence = selectors.sequence(item);
		if (sequence !== undefined) assistantTargets.add(sequence);
	}

	const steersByTarget = new Map<number, T[]>();
	const movable = new Set<T>();
	for (const item of items) {
		if (selectors.role(item) !== "user") continue;
		const target = selectors.steerTargetSequence(item);
		if (target == null || !assistantTargets.has(target)) continue;
		const group = steersByTarget.get(target) ?? [];
		group.push(item);
		steersByTarget.set(target, group);
		movable.add(item);
	}
	if (movable.size === 0) return [...items];

	const ordered: T[] = [];
	for (const item of items) {
		if (movable.has(item)) continue;
		if (selectors.role(item) === "assistant") {
			const sequence = selectors.sequence(item);
			if (sequence !== undefined) {
				ordered.push(...(steersByTarget.get(sequence) ?? []));
			}
		}
		ordered.push(item);
	}
	return ordered;
}
