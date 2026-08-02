import type { ToolEventMessage } from "#/server/protocol";
import type { UserMessage } from "./chatReducer";

export type AssistantTranscriptItem =
	| {
			kind: "steer";
			key: string;
			steerIndex: number;
			boundary: number;
	  }
	| {
			kind: "tool";
			key: string;
			eventIndex: number;
	  }
	| {
			kind: "task_group";
			key: string;
			eventIndices: readonly number[];
	  };

export type AssistantTranscriptPlan = {
	items: readonly AssistantTranscriptItem[];
	workflowChildEventIndices: ReadonlyMap<string, readonly number[]>;
	activeSubagentEventIndices: readonly number[];
	groupedProjectPreviewEventIndices: readonly number[];
	taskActivityGroups: readonly TaskActivityGroupPlan[];
};

export type TaskActivityGroupPlan = {
	key: string;
	eventIndices: readonly number[];
};

type PlanAssistantTranscriptOptions = {
	toolEvents: readonly ToolEventMessage[];
	acceptedSteers: readonly UserMessage[];
	toolEventStartIndex: number;
	groupedProjectPreviewEventIds?: ReadonlySet<string>;
	isProjectPreviewEvent: (event: ToolEventMessage) => boolean;
};

const activeSubagentStatuses = new Set(["pending", "running", "paused"]);

function acceptedSteerBoundary(
	steer: UserMessage,
	toolEventCount: number,
): number {
	const rawBoundary = Number.isFinite(steer.steerToolEventIndex)
		? Math.floor(steer.steerToolEventIndex as number)
		: toolEventCount;
	return Math.min(toolEventCount, Math.max(0, rawBoundary));
}

function indexWorkflowEvents(
	toolEvents: readonly ToolEventMessage[],
): Map<string, number> {
	const eventIndexByAgentId = new Map<string, number>();
	for (const [eventIndex, event] of toolEvents.entries()) {
		if (event.subagent?.kind === "workflow") {
			eventIndexByAgentId.set(event.subagent.agentId, eventIndex);
		}
	}
	return eventIndexByAgentId;
}

function crossesSteerBoundary(
	parentIndex: number,
	childIndex: number,
	boundaries: readonly number[],
): boolean {
	return boundaries.some(
		(boundary) => parentIndex < boundary && boundary <= childIndex,
	);
}

function planWorkflowChildren(
	toolEvents: readonly ToolEventMessage[],
	acceptedSteerBoundaries: readonly number[],
): {
	childEventIndices: Map<string, number[]>;
	nestedEventIds: Set<string>;
} {
	const workflowEventIndices = indexWorkflowEvents(toolEvents);
	const childEventIndices = new Map<string, number[]>();
	const nestedEventIds = new Set<string>();
	for (const [eventIndex, event] of toolEvents.entries()) {
		const child = event.subagent;
		if (!child?.parentActivityId) continue;
		const parentIndex = workflowEventIndices.get(child.parentActivityId);
		if (parentIndex === undefined) continue;
		// A child emitted after an accepted steer belongs below that receipt.
		if (
			crossesSteerBoundary(parentIndex, eventIndex, acceptedSteerBoundaries)
		) {
			continue;
		}
		nestedEventIds.add(event.id);
		const children = childEventIndices.get(child.parentActivityId) ?? [];
		children.push(eventIndex);
		childEventIndices.set(child.parentActivityId, children);
	}
	return { childEventIndices, nestedEventIds };
}

function isActiveSubagentEvent(
	event: ToolEventMessage,
	nestedEventIds: ReadonlySet<string>,
): boolean {
	const status = event.subagent?.status;
	return (
		!nestedEventIds.has(event.id) &&
		status !== undefined &&
		activeSubagentStatuses.has(status)
	);
}

function collectActiveSubagentEventIndices(
	toolEvents: readonly ToolEventMessage[],
	nestedEventIds: ReadonlySet<string>,
): number[] {
	const eventIndices: number[] = [];
	for (const [eventIndex, event] of toolEvents.entries()) {
		if (isActiveSubagentEvent(event, nestedEventIds)) {
			eventIndices.push(eventIndex);
		}
	}
	return eventIndices;
}

function isGroupedProjectPreviewEvent(
	event: ToolEventMessage,
	groupedEventIds: ReadonlySet<string> | undefined,
	isProjectPreviewEvent: (event: ToolEventMessage) => boolean,
): boolean {
	return (
		isProjectPreviewEvent(event) &&
		(groupedEventIds === undefined || groupedEventIds.has(event.id))
	);
}

function collectGroupedProjectPreviewEventIndices(
	toolEvents: readonly ToolEventMessage[],
	groupedEventIds: ReadonlySet<string> | undefined,
	isProjectPreviewEvent: (event: ToolEventMessage) => boolean,
): number[] {
	const eventIndices: number[] = [];
	for (const [eventIndex, event] of toolEvents.entries()) {
		if (
			isGroupedProjectPreviewEvent(
				event,
				groupedEventIds,
				isProjectPreviewEvent,
			)
		) {
			eventIndices.push(eventIndex);
		}
	}
	return eventIndices;
}

function groupSteersByVisibleBoundary(
	acceptedSteerBoundaries: readonly number[],
	visibleToolStart: number,
	toolEventCount: number,
): Map<number, number[]> {
	const steerIndicesByBoundary = new Map<number, number[]>();
	for (const [steerIndex, rawBoundary] of acceptedSteerBoundaries.entries()) {
		const boundary = Math.min(
			toolEventCount,
			Math.max(visibleToolStart, rawBoundary),
		);
		const steerIndices = steerIndicesByBoundary.get(boundary) ?? [];
		steerIndices.push(steerIndex);
		steerIndicesByBoundary.set(boundary, steerIndices);
	}
	return steerIndicesByBoundary;
}

type BuildTranscriptItemsOptions = {
	toolEvents: readonly ToolEventMessage[];
	acceptedSteers: readonly UserMessage[];
	acceptedSteerBoundaries: readonly number[];
	visibleToolStart: number;
	nestedEventIds: ReadonlySet<string>;
	activeSubagentEventIndices: readonly number[];
	groupedProjectPreviewEventIndices: readonly number[];
	taskActivityGroupsByAnchor: ReadonlyMap<number, TaskActivityGroupPlan>;
};

function collectTaskActivityGroups(
	toolEvents: readonly ToolEventMessage[],
	acceptedSteerBoundaries: readonly number[],
): TaskActivityGroupPlan[] {
	const boundarySet = new Set(acceptedSteerBoundaries);
	const groupsBySegmentAndSource = new Map<string, number[]>();
	let segment = 0;
	for (let eventIndex = 0; eventIndex < toolEvents.length; eventIndex++) {
		if (boundarySet.has(eventIndex)) segment++;
		const source = toolEvents[eventIndex].taskActivity?.source;
		if (!source) continue;
		const key = `${segment}:${source}`;
		const indices = groupsBySegmentAndSource.get(key) ?? [];
		indices.push(eventIndex);
		groupsBySegmentAndSource.set(key, indices);
	}
	return [...groupsBySegmentAndSource.values()].map((eventIndices) => ({
		key: `task-group:${toolEvents[eventIndices[0]].id}`,
		eventIndices,
	}));
}

function indexVisibleTaskActivityGroups(
	groups: readonly TaskActivityGroupPlan[],
	visibleToolStart: number,
): Map<number, TaskActivityGroupPlan> {
	const groupsByAnchor = new Map<number, TaskActivityGroupPlan>();
	for (const group of groups) {
		const visibleAnchor = group.eventIndices.find(
			(eventIndex) => eventIndex >= visibleToolStart,
		);
		if (visibleAnchor !== undefined) groupsByAnchor.set(visibleAnchor, group);
	}
	return groupsByAnchor;
}

function buildTranscriptItems({
	toolEvents,
	acceptedSteers,
	acceptedSteerBoundaries,
	visibleToolStart,
	nestedEventIds,
	activeSubagentEventIndices,
	groupedProjectPreviewEventIndices,
	taskActivityGroupsByAnchor,
}: BuildTranscriptItemsOptions): AssistantTranscriptItem[] {
	const steerIndicesByBoundary = groupSteersByVisibleBoundary(
		acceptedSteerBoundaries,
		visibleToolStart,
		toolEvents.length,
	);
	const activeSubagentEventIndexSet = new Set(activeSubagentEventIndices);
	const groupedProjectPreviewEventIndexSet = new Set(
		groupedProjectPreviewEventIndices,
	);
	const groupedTaskEventIndices = new Set(
		[...taskActivityGroupsByAnchor.values()].flatMap((group) => [
			...group.eventIndices,
		]),
	);
	const items: AssistantTranscriptItem[] = [];
	for (
		let eventIndex = visibleToolStart;
		eventIndex <= toolEvents.length;
		eventIndex++
	) {
		for (const steerIndex of steerIndicesByBoundary.get(eventIndex) ?? []) {
			const steer = acceptedSteers[steerIndex];
			items.push({
				kind: "steer",
				key: `steer:${steer.id}`,
				steerIndex,
				boundary: eventIndex,
			});
		}
		const taskActivityGroup = taskActivityGroupsByAnchor.get(eventIndex);
		if (taskActivityGroup) {
			items.push({
				kind: "task_group",
				key: taskActivityGroup.key,
				eventIndices: taskActivityGroup.eventIndices,
			});
		}
		if (
			eventIndex < toolEvents.length &&
			!groupedTaskEventIndices.has(eventIndex) &&
			!activeSubagentEventIndexSet.has(eventIndex) &&
			!nestedEventIds.has(toolEvents[eventIndex].id) &&
			!groupedProjectPreviewEventIndexSet.has(eventIndex)
		) {
			items.push({
				kind: "tool",
				key: toolEvents[eventIndex].id,
				eventIndex,
			});
		}
	}
	return items;
}

/**
 * Derives transcript placement without creating React nodes or copying event
 * payloads. Callers resolve the returned indices against their original arrays.
 */
export function planAssistantTranscript({
	toolEvents,
	acceptedSteers,
	toolEventStartIndex,
	groupedProjectPreviewEventIds,
	isProjectPreviewEvent,
}: PlanAssistantTranscriptOptions): AssistantTranscriptPlan {
	const acceptedSteerBoundaries = acceptedSteers.map((steer) =>
		acceptedSteerBoundary(steer, toolEvents.length),
	);
	const workflow = planWorkflowChildren(toolEvents, acceptedSteerBoundaries);
	const activeSubagentEventIndices = collectActiveSubagentEventIndices(
		toolEvents,
		workflow.nestedEventIds,
	);
	const groupedProjectPreviewEventIndices =
		collectGroupedProjectPreviewEventIndices(
			toolEvents,
			groupedProjectPreviewEventIds,
			isProjectPreviewEvent,
		);
	const visibleToolStart = Math.min(
		Math.max(0, toolEventStartIndex),
		toolEvents.length,
	);
	const taskActivityGroups = collectTaskActivityGroups(
		toolEvents,
		acceptedSteerBoundaries,
	);
	const taskActivityGroupsByAnchor = indexVisibleTaskActivityGroups(
		taskActivityGroups,
		visibleToolStart,
	);
	const items = buildTranscriptItems({
		toolEvents,
		acceptedSteers,
		acceptedSteerBoundaries,
		visibleToolStart,
		nestedEventIds: workflow.nestedEventIds,
		activeSubagentEventIndices,
		groupedProjectPreviewEventIndices,
		taskActivityGroupsByAnchor,
	});
	return {
		items,
		workflowChildEventIndices: workflow.childEventIndices,
		activeSubagentEventIndices,
		groupedProjectPreviewEventIndices,
		taskActivityGroups,
	};
}
