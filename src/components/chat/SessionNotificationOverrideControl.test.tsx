// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getPushNotificationDevices,
	getSessionNotificationOverride,
	type PushNotificationDevice,
	type SessionNotificationPolicyState,
	setSessionNotificationOverride,
} from "#/lib/pushNotifications";
import {
	SessionNotificationOverrideButton,
	SessionNotificationOverrideControl,
} from "./SessionNotificationOverrideControl";

vi.mock("#/lib/pushNotifications", () => ({
	getPushNotificationDevices: vi.fn(),
	getSessionNotificationOverride: vi.fn(),
	setSessionNotificationOverride: vi.fn(),
}));

const PHONE_ID = "11111111-1111-4111-8111-111111111111";
const LAPTOP_ID = "22222222-2222-4222-8222-222222222222";

const phone: PushNotificationDevice = {
	id: PHONE_ID,
	name: "Phone",
	current: true,
	enabled: true,
	createdAt: 1_000,
	lastSeenAt: 2_000,
	pausedUntil: null,
	pausedIndefinitely: false,
	preferences: {
		requests: true,
		problems: true,
		workFinished: false,
		detail: "generic",
		completionMinimumMinutes: 0,
		quietHours: null,
	},
	lastAcceptedAt: null,
	lastFailureAt: null,
	lastFailureMessage: null,
	failureCount: 0,
};

const laptop: PushNotificationDevice = {
	...phone,
	id: LAPTOP_ID,
	name: "Laptop",
	current: false,
};

function defaultState(sessionId: string): SessionNotificationPolicyState {
	return {
		policy: null,
		effective: {
			requestedSessionId: sessionId,
			sourceSessionId: null,
			mode: "default",
			scope: "session",
			targetDeviceIds: null,
			inherited: false,
		},
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPushNotificationDevices).mockResolvedValue([phone, laptop]);
	vi.mocked(getSessionNotificationOverride).mockImplementation(
		async (sessionId) => defaultState(sessionId),
	);
	vi.mocked(setSessionNotificationOverride).mockImplementation(
		async (sessionId, update) => {
			if (update.mode === "default") return defaultState(sessionId);
			return {
				policy: {
					sessionId,
					mode: update.mode,
					scope: update.scope,
					targetDeviceIds: update.targetDeviceIds,
					updatedAt: 3_000,
				},
				effective: {
					requestedSessionId: sessionId,
					sourceSessionId: sessionId,
					mode: update.mode,
					scope: update.scope,
					targetDeviceIds: update.targetDeviceIds,
					inherited: false,
				},
			};
		},
	);
});

describe("SessionNotificationOverrideButton", () => {
	it("opens the anchored dialog and restores focus when Escape closes it", async () => {
		render(<SessionNotificationOverrideButton sessionId="session-1" />);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});

		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen.queryByRole("dialog", {
				name: "Session notification settings",
			}),
		).toBeNull();

		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "Session notification settings",
		});
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(dialog);

		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", {
					name: "Session notification settings",
				}),
			).toBeNull(),
		);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
	});

	it("closes for an outside interaction or a different session", async () => {
		const { rerender } = render(
			<SessionNotificationOverrideButton sessionId="session-1" />,
		);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});
		fireEvent.click(trigger);
		await screen.findByRole("dialog", {
			name: "Session notification settings",
		});

		fireEvent.pointerDown(document.body);
		expect(
			screen.queryByRole("dialog", {
				name: "Session notification settings",
			}),
		).toBeNull();

		fireEvent.click(trigger);
		await screen.findByRole("dialog", {
			name: "Session notification settings",
		});
		rerender(<SessionNotificationOverrideButton sessionId="session-2" />);
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", {
					name: "Session notification settings",
				}),
			).toBeNull(),
		);
	});

	it("preserves the active control when the anchored dialog is repositioned", async () => {
		render(<SessionNotificationOverrideButton sessionId="session-1" />);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "Session notification settings",
		});
		const defaultMode = await screen.findByRole("button", { name: "Default" });
		defaultMode.focus();
		const originalTop = dialog.style.top;

		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
			top: 700,
			right: 100,
			bottom: 732,
		} as DOMRect);
		fireEvent(window, new Event("resize"));

		await waitFor(() => expect(dialog.style.top).not.toBe(originalTop));
		expect(document.activeElement).toBe(defaultMode);
	});

	it("follows composer layout movement without stealing focus", async () => {
		let resizeCallback: ResizeObserverCallback | null = null;
		const observed = new Set<Element>();
		class MockResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				resizeCallback = callback;
			}
			observe(element: Element) {
				observed.add(element);
			}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("ResizeObserver", MockResizeObserver);
		const composer = document.createElement("div");

		render(
			<SessionNotificationOverrideButton
				sessionId="session-1"
				trackingRef={{ current: composer }}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});
		let anchor = { top: 384, right: 100, bottom: 420 };
		vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(
			() => anchor as DOMRect,
		);
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "Session notification settings",
		});
		const defaultMode = await screen.findByRole("button", { name: "Default" });
		defaultMode.focus();
		const originalTop = dialog.style.top;
		expect(observed.has(composer)).toBe(true);

		anchor = { top: 300, right: 100, bottom: 336 };
		act(() => resizeCallback?.([], {} as ResizeObserver));

		await waitFor(() => expect(dialog.style.top).not.toBe(originalTop));
		expect(document.activeElement).toBe(defaultMode);
	});

	it("repositions when the visual viewport is panned", async () => {
		const listeners = new Map<string, Set<EventListener>>();
		const viewport = {
			width: 360,
			height: 400,
			offsetLeft: 20,
			offsetTop: 180,
			addEventListener(type: string, listener: EventListener) {
				const current = listeners.get(type) ?? new Set<EventListener>();
				current.add(listener);
				listeners.set(type, current);
			},
			removeEventListener(type: string, listener: EventListener) {
				listeners.get(type)?.delete(listener);
			},
		};
		vi.stubGlobal("visualViewport", viewport);

		render(<SessionNotificationOverrideButton sessionId="session-1" />);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});
		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
			top: 500,
			right: 370,
			bottom: 540,
		} as DOMRect);
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", {
			name: "Session notification settings",
		});
		const originalTop = dialog.style.top;

		viewport.offsetTop = 220;
		act(() => {
			for (const listener of listeners.get("scroll") ?? []) {
				listener(new Event("scroll"));
			}
		});

		await waitFor(() => expect(dialog.style.top).not.toBe(originalTop));
		expect(Number.parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(32);
		expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(232);
	});

	it("closes after an explicit save succeeds and restores focus", async () => {
		render(<SessionNotificationOverrideButton sessionId="session-1" />);
		const trigger = screen.getByRole("button", {
			name: "Session notifications",
		});
		fireEvent.click(trigger);
		const mute = await screen.findByRole("button", { name: "Mute" });
		fireEvent.click(mute);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", {
					name: "Session notification settings",
				}),
			).toBeNull(),
		);
		expect(setSessionNotificationOverride).toHaveBeenCalledWith("session-1", {
			mode: "mute",
			scope: "session",
			targetDeviceIds: null,
		});
		expect(document.activeElement).toBe(trigger);
	});

	it("stays open when an explicit save fails", async () => {
		vi.mocked(setSessionNotificationOverride).mockRejectedValue(
			new Error("Save failed"),
		);
		render(<SessionNotificationOverrideButton sessionId="session-1" />);
		fireEvent.click(
			screen.getByRole("button", { name: "Session notifications" }),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Mute" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Save failed",
		);
		expect(
			screen.getByRole("dialog", {
				name: "Session notification settings",
			}),
		).toBeTruthy();
	});
});

describe("SessionNotificationOverrideControl", () => {
	it("loads the explicit and effective policy without changing it", async () => {
		render(<SessionNotificationOverrideControl sessionId="session 1" />);

		expect(
			screen.getByLabelText("Loading session notification setting"),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Default" })
					.getAttribute("aria-pressed"),
			).toBe("true"),
		);
		expect(
			screen.getByLabelText("Effective notification policy").textContent,
		).toContain("Effective: Default device rules");
		expect(getSessionNotificationOverride).toHaveBeenCalledWith("session 1");
		expect(getPushNotificationDevices).toHaveBeenCalledOnce();
		expect(setSessionNotificationOverride).not.toHaveBeenCalled();
	});

	it("saves completion-only notification for a delegation tree and exact devices", async () => {
		render(<SessionNotificationOverrideControl sessionId="session-2" />);
		const completion = await screen.findByRole("button", {
			name: "Notify when finished",
		});
		expect(completion.className).toContain("min-h-11");
		fireEvent.click(completion);
		const scope = screen.getByLabelText("Notification scope");
		expect(scope.className).toContain("min-h-11");
		fireEvent.change(scope, {
			target: { value: "delegation_tree" },
		});
		const deviceTarget = screen.getByLabelText("Notification devices");
		expect(deviceTarget.className).toContain("min-h-11");
		fireEvent.change(deviceTarget, {
			target: { value: "exact" },
		});

		const save = screen.getByRole("button", { name: "Save" });
		expect(save.className).toContain("min-h-11");
		expect((save as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("alert").textContent).toContain(
			"Choose at least one exact notification device",
		);

		const phoneTarget = screen.getByRole("checkbox", {
			name: "Phone (this device)",
		});
		expect(phoneTarget.closest("label")?.className).toContain("min-h-11");
		fireEvent.click(phoneTarget);
		fireEvent.click(screen.getByRole("checkbox", { name: "Laptop" }));
		expect((save as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(save);

		await waitFor(() =>
			expect(setSessionNotificationOverride).toHaveBeenCalledWith("session-2", {
				mode: "notify_completion_once",
				scope: "delegation_tree",
				targetDeviceIds: [PHONE_ID, LAPTOP_ID],
			}),
		);
		const effective = screen.getByLabelText("Effective notification policy");
		expect(effective.textContent).toContain("Notify when finished once");
		expect(effective.textContent).toContain(
			"This session and its delegated sessions",
		);
		expect(effective.textContent).toContain("Phone and Laptop");
	});

	it("shows an inherited policy while keeping Default as the explicit choice", async () => {
		vi.mocked(getSessionNotificationOverride).mockResolvedValue({
			policy: null,
			effective: {
				requestedSessionId: "child-session",
				sourceSessionId: "parent-session",
				mode: "mute",
				scope: "delegation_tree",
				targetDeviceIds: [PHONE_ID],
				inherited: true,
			},
		});
		render(<SessionNotificationOverrideControl sessionId="child-session" />);

		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Default" })
					.getAttribute("aria-pressed"),
			).toBe("true"),
		);
		const effective = screen.getByLabelText("Effective notification policy");
		expect(effective.textContent).toContain("Effective: Muted");
		expect(effective.textContent).toContain("Phone");
		expect(effective.textContent).toContain(
			"Inherited from parent session parent-session.",
		);
	});

	it("preserves an unavailable exact target so Default cannot widen it", async () => {
		const missingId = "33333333-3333-4333-8333-333333333333";
		vi.mocked(getSessionNotificationOverride).mockResolvedValue({
			policy: {
				sessionId: "session-missing",
				mode: "mute",
				scope: "session",
				targetDeviceIds: [missingId],
				updatedAt: 3_000,
			},
			effective: {
				requestedSessionId: "session-missing",
				sourceSessionId: "session-missing",
				mode: "mute",
				scope: "session",
				targetDeviceIds: [missingId],
				inherited: false,
			},
		});
		render(<SessionNotificationOverrideControl sessionId="session-missing" />);

		expect(
			await screen.findByText(`Unavailable device ${missingId}`),
		).toBeTruthy();
		expect(
			screen
				.getByRole("checkbox", {
					name: `Unavailable device ${missingId}`,
				})
				.getAttribute("checked"),
		).not.toBeNull();
	});

	it("restores the saved choice when saving fails", async () => {
		vi.mocked(getSessionNotificationOverride).mockResolvedValue({
			policy: {
				sessionId: "session-3",
				mode: "notify",
				scope: "session",
				targetDeviceIds: null,
				updatedAt: 2_000,
			},
			effective: {
				requestedSessionId: "session-3",
				sourceSessionId: "session-3",
				mode: "notify",
				scope: "session",
				targetDeviceIds: null,
				inherited: false,
			},
		});
		vi.mocked(setSessionNotificationOverride).mockRejectedValue(
			new Error("Save failed"),
		);
		render(<SessionNotificationOverrideControl sessionId="session-3" />);
		const mute = await screen.findByRole("button", { name: "Mute" });
		fireEvent.click(mute);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toContain("Save failed");
		expect(
			screen
				.getByRole("button", { name: "Always notify" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});
});
