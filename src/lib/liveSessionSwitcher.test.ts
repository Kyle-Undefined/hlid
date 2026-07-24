import { describe, expect, it } from "vitest";
import type { SessionStatusEntry } from "#/server/protocol";
import {
	deriveLiveSessionSwitcherRows,
	liveSessionContext,
	liveSessionState,
	liveSessionToggleTone,
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
		).toBe("waiting");
		expect(liveSessionState(session("error", { state: "error" }))).toBe(
			"waiting",
		);
		expect(liveSessionState(session("running", { state: "running" }))).toBe(
			"working",
		);
		expect(liveSessionState(session("idle"))).toBe("ready");
	});

	it("orders Waiting, Working, and Ready while preserving pool order within groups", () => {
		const rows = deriveLiveSessionSwitcherRows([
			session("ready-a"),
			session("working-a", { state: "running" }),
			session("waiting-a", { hasPendingPermissions: true }),
			session("working-b", { state: "running" }),
			session("ready-b"),
		]);

		expect(rows.map((row) => row.dbSessionId)).toEqual([
			"chat-waiting-a",
			"chat-working-a",
			"chat-working-b",
			"chat-ready-a",
			"chat-ready-b",
		]);
	});
});

describe("live session presentation", () => {
	it("gives attention precedence in the aggregate toggle tone", () => {
		const ready = deriveLiveSessionSwitcherRows([session("ready")]);
		const working = deriveLiveSessionSwitcherRows([
			session("ready"),
			session("working", { state: "running" }),
		]);
		const waiting = deriveLiveSessionSwitcherRows([
			session("working", { state: "running" }),
			session("waiting", { state: "error" }),
		]);

		expect(liveSessionToggleTone([])).toBe("empty");
		expect(liveSessionToggleTone(ready)).toBe("ready");
		expect(liveSessionToggleTone(working)).toBe("working");
		expect(liveSessionToggleTone(waiting)).toBe("waiting");
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
	});
});
