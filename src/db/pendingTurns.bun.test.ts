import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { appendMessage, getUserMessageSeqByTurnId } from "./messages";
import {
	deletePendingSessionTurn,
	discardDispatchingSessionTurnsAfterRestart,
	enqueuePendingSessionTurn,
	listRecoverablePendingSessionTurns,
	markPendingSessionTurnDispatching,
	markPendingSessionTurnSleeping,
	promotePendingSessionTurn,
} from "./pendingTurns";
import { setDbForTest } from "./schema";
import { createSession, setSessionArchived } from "./sessions";

describe("durable Raven pending turns", () => {
	beforeEach(() => {
		setDbForTest(new Database(":memory:"));
	});

	it("persists FIFO payloads and rejects a duplicate turn id", async () => {
		await createSession("session-1", "Queue", "gpt-test");
		expect(
			await enqueuePendingSessionTurn({
				turnId: "turn-1",
				sessionId: "session-1",
				payloadJson: '{"userMessage":"first","options":{}}',
			}),
		).toBe(true);
		expect(
			await enqueuePendingSessionTurn({
				turnId: "turn-2",
				sessionId: "session-1",
				payloadJson: '{"userMessage":"second","options":{}}',
			}),
		).toBe(true);
		expect(
			await enqueuePendingSessionTurn({
				turnId: "turn-1",
				sessionId: "session-1",
				payloadJson: "{}",
			}),
		).toBe(false);

		expect(
			(await listRecoverablePendingSessionTurns()).map((row) => row.turn_id),
		).toEqual(["turn-1", "turn-2"]);
	});

	it("rejects a client retry after its user turn was persisted", async () => {
		await createSession("session-1", "Queue", "gpt-test");
		await appendMessage("session-1", 0, "user", "already sent", "turn-1");

		expect(await getUserMessageSeqByTurnId("session-1", "turn-1")).toBe(0);
		expect(
			await enqueuePendingSessionTurn({
				turnId: "turn-1",
				sessionId: "session-1",
				payloadJson: '{"userMessage":"already sent","options":{}}',
			}),
		).toBe(false);
		expect(await listRecoverablePendingSessionTurns()).toEqual([]);
	});

	it("retains sleep timing and promoted order", async () => {
		await createSession("session-1", "Queue", "gpt-test");
		for (const turnId of ["turn-1", "turn-2"]) {
			await enqueuePendingSessionTurn({
				turnId,
				sessionId: "session-1",
				payloadJson: JSON.stringify({ userMessage: turnId, options: {} }),
			});
		}
		await markPendingSessionTurnSleeping({
			turnId: "turn-1",
			providerId: "codex",
			windowId: "weekly",
			reason: "threshold",
			until: 2_000,
			target: 2_500,
			utilization: 0.99,
			capDeadline: 2_000,
		});
		let rows = await listRecoverablePendingSessionTurns();
		expect(rows[0]).toMatchObject({
			state: "sleeping",
			provider_id: "codex",
			window_id: "weekly",
			sleep_until: 2_000,
			sleep_target: 2_500,
			cap_deadline: 2_000,
		});

		await promotePendingSessionTurn({
			sessionId: "session-1",
			turnId: "turn-2",
		});
		rows = await listRecoverablePendingSessionTurns();
		expect(rows.map((row) => row.turn_id)).toEqual(["turn-2", "turn-1"]);
		expect(rows[1]).toMatchObject({
			state: "sleeping",
			provider_id: "codex",
			window_id: "weekly",
		});
	});

	it("never recovers a turn that crossed the dispatch boundary", async () => {
		await createSession("session-1", "Queue", "gpt-test");
		await enqueuePendingSessionTurn({
			turnId: "turn-1",
			sessionId: "session-1",
			payloadJson: '{"userMessage":"first","options":{}}',
		});
		await markPendingSessionTurnDispatching("turn-1");

		expect(await listRecoverablePendingSessionTurns()).toEqual([]);
		expect(await discardDispatchingSessionTurnsAfterRestart()).toBe(1);
		expect(await discardDispatchingSessionTurnsAfterRestart()).toBe(0);
	});

	it("hides archived sessions and cascades explicit deletion", async () => {
		await createSession("session-1", "Queue", "gpt-test");
		await enqueuePendingSessionTurn({
			turnId: "turn-1",
			sessionId: "session-1",
			payloadJson: '{"userMessage":"first","options":{}}',
		});
		await setSessionArchived("session-1", true);
		expect(await listRecoverablePendingSessionTurns()).toEqual([]);

		await deletePendingSessionTurn("turn-1");
		expect(await listRecoverablePendingSessionTurns()).toEqual([]);
	});
});
