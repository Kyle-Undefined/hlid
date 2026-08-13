// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePushNotificationsForSession } from "#/lib/pushNotifications";
import {
	notificationPageIsVisible,
	useNotificationPresence,
} from "./useNotificationPresence";

vi.mock("#/lib/pushNotifications", () => ({
	closePushNotificationsForSession: vi.fn(async () => {}),
}));

let visibility: DocumentVisibilityState;
let focused: boolean;
type PresenceSend = Parameters<typeof useNotificationPresence>[3];

function mockSend() {
	return vi.fn<PresenceSend>(() => true);
}

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	focused = true;
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	vi.mocked(closePushNotificationsForSession).mockClear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("notificationPageIsVisible", () => {
	it("requires both a visible document and window focus", () => {
		expect(
			notificationPageIsVisible({
				visibilityState: "visible",
				hasFocus: () => true,
			}),
		).toBe(true);
		expect(
			notificationPageIsVisible({
				visibilityState: "hidden",
				hasFocus: () => true,
			}),
		).toBe(false);
		expect(
			notificationPageIsVisible({
				visibilityState: "visible",
				hasFocus: () => false,
			}),
		).toBe(false);
	});
});

describe("useNotificationPresence", () => {
	it("announces visible presence immediately and renews it by heartbeat", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("pool-1", "db-1", "connected", send),
		);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: true,
		});
		expect(closePushNotificationsForSession).toHaveBeenCalledOnce();
		expect(closePushNotificationsForSession).toHaveBeenCalledWith("db-1");

		act(() => vi.advanceTimersByTime(5_000));
		expect(send).toHaveBeenCalledTimes(2);
		expect(closePushNotificationsForSession).toHaveBeenCalledOnce();
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: true,
		});
		unmount();
	});

	it("clears on blur or hide and restores on focus or visibility", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("pool-1", "db-1", "connected", send),
		);

		focused = false;
		act(() => window.dispatchEvent(new Event("blur")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: false,
		});

		focused = true;
		act(() => window.dispatchEvent(new Event("focus")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: true,
		});
		expect(closePushNotificationsForSession).toHaveBeenCalledTimes(2);

		visibility = "hidden";
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: false,
		});

		visibility = "visible";
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-1",
			visible: true,
		});
		expect(closePushNotificationsForSession).toHaveBeenCalledTimes(3);
		unmount();
	});

	it("clears the old lease on session changes, disconnect, and unmount", () => {
		const send = mockSend();
		const { rerender, unmount } = renderHook(
			({ sessionId, notificationSessionId, wsStatus }) =>
				useNotificationPresence(
					sessionId,
					notificationSessionId,
					wsStatus,
					send,
				),
			{
				initialProps: {
					sessionId: "pool-1",
					notificationSessionId: "db-1" as string | null,
					wsStatus: "connected",
				},
			},
		);

		rerender({
			sessionId: "pool-2",
			notificationSessionId: "db-2",
			wsStatus: "connected",
		});
		expect(send.mock.calls.slice(-2).map(([message]) => message)).toEqual([
			{
				type: "notification_presence",
				session_id: "pool-1",
				visible: false,
			},
			{
				type: "notification_presence",
				session_id: "pool-2",
				visible: true,
			},
		]);
		expect(closePushNotificationsForSession).toHaveBeenLastCalledWith("db-2");

		rerender({
			sessionId: "pool-2",
			notificationSessionId: "db-2",
			wsStatus: "disconnected",
		});
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-2",
			visible: false,
		});

		rerender({
			sessionId: "pool-3",
			notificationSessionId: "db-3",
			wsStatus: "connected",
		});
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-3",
			visible: true,
		});
		expect(closePushNotificationsForSession).toHaveBeenLastCalledWith("db-3");
		unmount();
		expect(send).toHaveBeenLastCalledWith({
			type: "notification_presence",
			session_id: "pool-3",
			visible: false,
		});
	});

	it("never closes notifications by an undurable presence identity", () => {
		const send = mockSend();
		const { unmount } = renderHook(() =>
			useNotificationPresence("pool-only", null, "connected", send),
		);

		expect(send).toHaveBeenCalledWith({
			type: "notification_presence",
			session_id: "pool-only",
			visible: true,
		});
		expect(closePushNotificationsForSession).not.toHaveBeenCalled();
		unmount();
	});
});
