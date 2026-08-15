// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearPendingSessionNotificationPolicy,
	loadPendingSessionNotificationPolicy,
	pendingSessionNotificationPolicyStorageKey,
	samePendingSessionNotificationPolicy,
	savePendingSessionNotificationPolicy,
} from "./pendingSessionNotificationPolicy";

const SESSION_ID = "new-session-1";

describe("pending session notification policy", () => {
	beforeEach(() => localStorage.clear());

	it("round-trips an exact provisional policy by reserved session ID", () => {
		const policy = {
			mode: "notify_completion_once" as const,
			scope: "delegation_tree" as const,
			targetDeviceIds: ["11111111-1111-4111-8111-111111111111"],
		};

		expect(savePendingSessionNotificationPolicy(SESSION_ID, policy)).toBe(true);
		expect(loadPendingSessionNotificationPolicy(SESSION_ID)).toEqual(policy);
		expect(loadPendingSessionNotificationPolicy("another-session")).toBeNull();
	});

	it("uses null as Default and clears the exact session only", () => {
		expect(
			savePendingSessionNotificationPolicy(SESSION_ID, {
				mode: "mute",
				scope: "session",
				targetDeviceIds: null,
			}),
		).toBe(true);
		expect(savePendingSessionNotificationPolicy(SESSION_ID, null)).toBe(true);
		expect(loadPendingSessionNotificationPolicy(SESSION_ID)).toBeNull();

		savePendingSessionNotificationPolicy(SESSION_ID, {
			mode: "notify",
			scope: "session",
			targetDeviceIds: null,
		});
		clearPendingSessionNotificationPolicy(SESSION_ID);
		expect(loadPendingSessionNotificationPolicy(SESSION_ID)).toBeNull();
	});

	it("rejects malformed IDs and fail-closed policy payloads", () => {
		expect(pendingSessionNotificationPolicyStorageKey(" session ")).toBeNull();
		expect(
			savePendingSessionNotificationPolicy(SESSION_ID, {
				mode: "mute",
				scope: "session",
				targetDeviceIds: [],
			}),
		).toBe(false);

		const key = pendingSessionNotificationPolicyStorageKey(SESSION_ID);
		expect(key).not.toBeNull();
		localStorage.setItem(
			key as string,
			JSON.stringify({
				version: 1,
				mode: "default",
				scope: "session",
				targetDeviceIds: null,
			}),
		);
		expect(loadPendingSessionNotificationPolicy(SESSION_ID)).toBeNull();
		expect(localStorage.getItem(key as string)).toBeNull();
	});

	it("compares policy snapshots without widening exact targets", () => {
		const policy = {
			mode: "notify" as const,
			scope: "session" as const,
			targetDeviceIds: [
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222",
			],
		};
		expect(
			samePendingSessionNotificationPolicy(policy, {
				...policy,
				targetDeviceIds: [...policy.targetDeviceIds].reverse(),
			}),
		).toBe(true);
		expect(
			samePendingSessionNotificationPolicy(policy, {
				...policy,
				targetDeviceIds: null,
			}),
		).toBe(false);
	});
});
