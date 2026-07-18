import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getSessionsStatus,
	reconcileSessionStatus,
	replaceSessionsStatus,
	resetSessionStatusForTesting,
	subscribeSessionsStatus,
} from "./wsSessionStatusStore";

const initialSession = {
	session_id: "session-a",
	agent_cwd: "/tmp/a",
	agent_name: "A",
	state: "idle" as const,
	model: "fake-fast",
	hasPendingPermissions: false,
	hasDbSession: true,
	db_session_id: "db-session-a",
};

describe("reconcileSessionStatus", () => {
	beforeEach(() => {
		resetSessionStatusForTesting();
		replaceSessionsStatus([initialSession]);
	});

	it("preserves the snapshot reference for an unchanged heartbeat", () => {
		const before = getSessionsStatus();
		const listener = vi.fn();
		const unsubscribe = subscribeSessionsStatus(listener);

		reconcileSessionStatus("session-a", {
			state: "idle",
			model: "fake-fast",
		});

		expect(getSessionsStatus()).toBe(before);
		expect(listener).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("publishes a new snapshot when status changes", () => {
		const before = getSessionsStatus();
		const listener = vi.fn();
		const unsubscribe = subscribeSessionsStatus(listener);

		reconcileSessionStatus("session-a", {
			state: "running",
			model: "fake-fast",
		});

		expect(getSessionsStatus()).not.toBe(before);
		expect(getSessionsStatus()[0]?.state).toBe("running");
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
	});
});
