import type { ServerMessage } from "./protocol";
import type { ProviderSkillReloadResult, SessionManager } from "./session";

type SkillRefreshEntry = {
	manager: Pick<SessionManager, "getProviderId" | "reloadProviderSkills">;
	runState: { broadcast(message: ServerMessage): void };
};

export type ClaudeSkillRefreshSummary = {
	providerId: "claude";
	status: "reloaded" | "not-live" | "partial" | "failed";
	matchingSessions: number;
	reloadedSessions: number;
	deferredSessions: number;
	failedSessions: number;
	skillCount: number | null;
	reason: string;
};

function sessionLabel(count: number): string {
	return `${count} session${count === 1 ? "" : "s"}`;
}

export async function refreshLiveClaudeSkills(
	entries: Iterable<SkillRefreshEntry>,
): Promise<ClaudeSkillRefreshSummary> {
	const candidates = [...entries].filter(
		(entry) => entry.manager.getProviderId() === "claude",
	);
	if (candidates.length === 0) {
		return {
			providerId: "claude",
			status: "not-live",
			matchingSessions: 0,
			reloadedSessions: 0,
			deferredSessions: 0,
			failedSessions: 0,
			skillCount: null,
			reason:
				"No Claude sessions are open. Hlid rescanned installed skills; a new Claude session will load them on start.",
		};
	}

	const settled = await Promise.allSettled(
		candidates.map((entry) =>
			entry.manager.reloadProviderSkills((message) =>
				entry.runState.broadcast(message),
			),
		),
	);
	const fulfilled = settled
		.filter(
			(result): result is PromiseFulfilledResult<ProviderSkillReloadResult> =>
				result.status === "fulfilled",
		)
		.map((result) => result.value);
	const reloaded = fulfilled.filter((result) => result.status === "reloaded");
	const deferredSessions = fulfilled.length - reloaded.length;
	const failedSessions = settled.length - fulfilled.length;
	const skillCount = reloaded.reduce(
		(maximum, result) =>
			result.status === "reloaded"
				? Math.max(maximum, result.skillCount)
				: maximum,
		0,
	);

	if (reloaded.length === 0 && failedSessions === 0) {
		return {
			providerId: "claude",
			status: "not-live",
			matchingSessions: candidates.length,
			reloadedSessions: 0,
			deferredSessions,
			failedSessions: 0,
			skillCount: null,
			reason:
				"Claude sessions are open, but none has a live native Query. Hlid rescanned installed skills; complete a Claude turn to make live refresh available.",
		};
	}

	if (failedSessions > 0 || deferredSessions > 0) {
		const partial = reloaded.length > 0;
		const incompleteParts = [
			failedSessions > 0
				? `${sessionLabel(failedSessions)} could not refresh`
				: null,
			deferredSessions > 0
				? `${sessionLabel(deferredSessions)} had no live Query`
				: null,
		].filter((part): part is string => part !== null);
		return {
			providerId: "claude",
			status: partial ? "partial" : "failed",
			matchingSessions: candidates.length,
			reloadedSessions: reloaded.length,
			deferredSessions,
			failedSessions,
			skillCount: reloaded.length ? skillCount : null,
			reason: partial
				? `Claude refreshed ${sessionLabel(reloaded.length)}, but ${incompleteParts.join(" and ")}. Hlid still rescanned installed skills.`
				: `Claude could not refresh ${incompleteParts.join(" or ")}. Hlid still rescanned installed skills for review and import.`,
		};
	}

	return {
		providerId: "claude",
		status: "reloaded",
		matchingSessions: candidates.length,
		reloadedSessions: reloaded.length,
		deferredSessions,
		failedSessions: 0,
		skillCount,
		reason: `Claude refreshed ${sessionLabel(reloaded.length)} and found ${skillCount} native skill${skillCount === 1 ? "" : "s"}. Hlid rescanned installed skills for review and import.`,
	};
}
