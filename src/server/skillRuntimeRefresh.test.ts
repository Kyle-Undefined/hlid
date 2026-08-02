import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "./protocol";
import { refreshLiveClaudeSkills } from "./skillRuntimeRefresh";

function entry(options: {
	providerId?: string;
	reload: (
		emit: (message: ServerMessage) => void,
	) => Promise<
		| { providerId: string; status: "reloaded"; skillCount: number }
		| { providerId: string; status: "not-live"; reason: string }
	>;
}) {
	return {
		manager: {
			getProviderId: vi.fn(() => options.providerId ?? "claude"),
			reloadProviderSkills: vi.fn(options.reload),
		},
		runState: { broadcast: vi.fn() },
	};
}

describe("refreshLiveClaudeSkills", () => {
	it("rescans without starting a Claude session when none is open", async () => {
		await expect(refreshLiveClaudeSkills([])).resolves.toMatchObject({
			status: "not-live",
			matchingSessions: 0,
			reloadedSessions: 0,
		});
	});

	it("reloads every live Claude Query and preserves session-scoped broadcasts", async () => {
		const first = entry({
			reload: async (emit) => {
				emit({
					type: "slash_commands",
					provider_id: "claude",
					commands: [],
				});
				return { providerId: "claude", status: "reloaded", skillCount: 3 };
			},
		});
		const second = entry({
			reload: async () => ({
				providerId: "claude",
				status: "reloaded",
				skillCount: 5,
			}),
		});
		const codex = entry({
			providerId: "codex",
			reload: async () => ({
				providerId: "codex",
				status: "not-live",
				reason: "unsupported",
			}),
		});

		await expect(
			refreshLiveClaudeSkills([first, second, codex]),
		).resolves.toMatchObject({
			status: "reloaded",
			matchingSessions: 2,
			reloadedSessions: 2,
			deferredSessions: 0,
			failedSessions: 0,
			skillCount: 5,
		});
		expect(first.runState.broadcast).toHaveBeenCalledWith({
			type: "slash_commands",
			provider_id: "claude",
			commands: [],
		});
		expect(codex.manager.reloadProviderSkills).not.toHaveBeenCalled();
	});

	it("reports partial refresh while allowing Hlid disk discovery to continue", async () => {
		const refreshed = entry({
			reload: async () => ({
				providerId: "claude",
				status: "reloaded",
				skillCount: 2,
			}),
		});
		const failed = entry({
			reload: async () => {
				throw new Error("transport closed");
			},
		});

		await expect(
			refreshLiveClaudeSkills([refreshed, failed]),
		).resolves.toMatchObject({
			status: "partial",
			reloadedSessions: 1,
			failedSessions: 1,
			skillCount: 2,
		});
	});

	it("reports a live and cold Claude session as a partial refresh", async () => {
		const refreshed = entry({
			reload: async () => ({
				providerId: "claude",
				status: "reloaded",
				skillCount: 2,
			}),
		});
		const cold = entry({
			reload: async () => ({
				providerId: "claude",
				status: "not-live",
				reason: "no live Query",
			}),
		});

		await expect(
			refreshLiveClaudeSkills([refreshed, cold]),
		).resolves.toMatchObject({
			status: "partial",
			reloadedSessions: 1,
			deferredSessions: 1,
			failedSessions: 0,
			skillCount: 2,
		});
	});
});
