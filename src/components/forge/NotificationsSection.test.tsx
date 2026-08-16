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
	disablePushNotifications,
	enablePushNotifications,
	getPushNotificationDevices,
	getPushNotificationHistory,
	getPushNotificationState,
	getPushNotificationSupport,
	type PushNotificationQuietHours,
	pausePushNotifications,
	renamePushNotificationDevice,
	revokePushNotificationDevice,
	sendTestPushNotification,
	updatePushNotificationDevice,
	updatePushNotificationPreferences,
} from "#/lib/pushNotifications";
import {
	NotificationsSection,
	notificationPauseDurationMs,
	notificationPauseUntilMs,
} from "./NotificationsSection";

vi.mock("#/lib/pushNotifications", () => ({
	disablePushNotifications: vi.fn(),
	enablePushNotifications: vi.fn(),
	getPushNotificationDevices: vi.fn(),
	getPushNotificationHistory: vi.fn(),
	getPushNotificationState: vi.fn(),
	getPushNotificationSupport: vi.fn(),
	pausePushNotifications: vi.fn(),
	renamePushNotificationDevice: vi.fn(),
	revokePushNotificationDevice: vi.fn(),
	sendTestPushNotification: vi.fn(),
	updatePushNotificationDevice: vi.fn(),
	updatePushNotificationPreferences: vi.fn(),
}));

const disabledState = {
	supported: true as const,
	permission: "default" as const,
	enabled: false,
	pausedUntil: null,
	pausedIndefinitely: false,
	preferences: {
		requests: true,
		problems: true,
		workFinished: false,
		detail: "generic" as const,
		completionMinimumMinutes: 0 as const,
		quietHours: null,
	},
};

const enabledState = {
	...disabledState,
	permission: "granted" as const,
	enabled: true,
};

const phone = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Phone",
	current: true,
	enabled: true,
	createdAt: new Date(2026, 0, 1, 12).getTime(),
	lastSeenAt: new Date(2026, 0, 2, 12).getTime(),
	pausedUntil: null,
	pausedIndefinitely: false,
	preferences: enabledState.preferences,
	lastAcceptedAt: new Date(2026, 0, 2, 12).getTime(),
	lastFailureAt: null,
	lastFailureMessage: null,
	failureCount: 0,
};

const desktop = {
	...phone,
	id: "22222222-2222-4222-8222-222222222222",
	name: "Desktop",
	current: false,
	lastAcceptedAt: null,
	lastFailureAt: new Date(2026, 0, 3, 12).getTime(),
	failureCount: 2,
};

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPushNotificationSupport).mockReturnValue({ supported: true });
	vi.mocked(getPushNotificationState).mockResolvedValue(disabledState);
	vi.mocked(getPushNotificationDevices).mockResolvedValue([]);
	vi.mocked(getPushNotificationHistory).mockResolvedValue([]);
	vi.mocked(enablePushNotifications).mockResolvedValue(enabledState);
	vi.mocked(disablePushNotifications).mockResolvedValue({
		...enabledState,
		enabled: false,
	});
	vi.mocked(updatePushNotificationPreferences).mockImplementation(
		async (preferences) => ({ ...enabledState, preferences }),
	);
	vi.mocked(pausePushNotifications).mockImplementation(async (until) => ({
		...enabledState,
		pausedUntil: typeof until === "number" ? until : null,
		pausedIndefinitely: until === "indefinite",
	}));
	vi.mocked(sendTestPushNotification).mockResolvedValue({
		accepted: true,
		acceptedAt: new Date(2026, 0, 4, 12).getTime(),
		failureAt: null,
		failureCount: 0,
		subscriptionRemoved: false,
	});
	vi.mocked(renamePushNotificationDevice).mockImplementation(
		async (id, name) => ({ ...(id === phone.id ? phone : desktop), name }),
	);
	vi.mocked(updatePushNotificationDevice).mockImplementation(
		async (id, patch) => {
			const device = id === phone.id ? phone : desktop;
			return {
				...device,
				...(patch.name === undefined ? {} : { name: patch.name.trim() }),
				preferences: {
					...device.preferences,
					...patch.preferences,
				},
			};
		},
	);
	vi.mocked(revokePushNotificationDevice).mockResolvedValue(true);
});

describe("notification pause values", () => {
	it("converts positive whole durations", () => {
		expect(notificationPauseDurationMs("30", "minutes")).toBe(1_800_000);
		expect(notificationPauseDurationMs("2", "hours")).toBe(7_200_000);
		expect(notificationPauseDurationMs("3", "days")).toBe(259_200_000);
	});

	it.each([
		"",
		"0",
		"-1",
		"1.5",
		"not-a-number",
	])("rejects invalid duration %s", (value) => {
		expect(notificationPauseDurationMs(value, "hours")).toBeNull();
	});

	it("accepts only future local date-time values", () => {
		const now = new Date(2026, 0, 2, 12).getTime();
		const future = "2026-01-03T08:30";
		expect(notificationPauseUntilMs(future, now)).toBe(
			new Date(future).getTime(),
		);
		expect(notificationPauseUntilMs("2026-01-01T08:30", now)).toBeNull();
		expect(notificationPauseUntilMs("", now)).toBeNull();
	});
});

describe("NotificationsSection", () => {
	it("shows recent notification decisions and per-device delivery state", async () => {
		vi.mocked(getPushNotificationHistory).mockResolvedValue([
			{
				id: "33333333-3333-4333-8333-333333333333",
				sourceKind: "session",
				sourceId: "session-1",
				category: "completion",
				reason: "work_finished",
				label: "Compile release",
				url: "/raven?session=session-1",
				runtimeMs: 30_000,
				pendingCount: 0,
				occurredAt: new Date(2026, 0, 2, 12).getTime(),
				expiresAt: new Date(2026, 0, 3, 12).getTime(),
				groupKey: "completion",
				batchId: "batch-one",
				status: "processed",
				statusReason: "delivery_complete",
				nextAttemptAt: null,
				deliveries: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						deviceId: phone.id,
						device: { id: phone.id, name: "Phone", privacy: "generic" },
						status: "sent",
						reason: null,
						nextAttemptAt: null,
						attemptCount: 1,
						providerStatus: 201,
						receiptAt: new Date(2026, 0, 2, 12, 0, 1).getTime(),
						displayedAt: new Date(2026, 0, 2, 12, 0, 2).getTime(),
						openedAt: null,
						dismissedAt: null,
						createdAt: new Date(2026, 0, 2, 12).getTime(),
						updatedAt: new Date(2026, 0, 2, 12, 0, 2).getTime(),
					},
					{
						id: "55555555-5555-4555-8555-555555555555",
						deviceId: desktop.id,
						device: {
							id: desktop.id,
							name: "Desktop",
							privacy: "detailed",
						},
						status: "suppressed",
						reason: "quiet_hours",
						nextAttemptAt: null,
						attemptCount: 0,
						providerStatus: null,
						receiptAt: null,
						displayedAt: null,
						openedAt: null,
						dismissedAt: null,
						createdAt: new Date(2026, 0, 2, 12).getTime(),
						updatedAt: new Date(2026, 0, 2, 12).getTime(),
					},
					{
						id: "66666666-6666-4666-8666-666666666666",
						deviceId: "77777777-7777-4777-8777-777777777777",
						device: {
							id: "77777777-7777-4777-8777-777777777777",
							name: "Tablet",
							privacy: "generic",
						},
						status: "queued",
						reason: "quiet_hours",
						nextAttemptAt: new Date(2026, 0, 2, 22).getTime(),
						attemptCount: 0,
						providerStatus: null,
						receiptAt: null,
						displayedAt: null,
						openedAt: null,
						dismissedAt: null,
						createdAt: new Date(2026, 0, 2, 12).getTime(),
						updatedAt: new Date(2026, 0, 2, 12).getTime(),
					},
				],
			},
		]);

		render(<NotificationsSection />);

		expect(await screen.findByText("Completion · session")).toBeTruthy();
		expect(screen.getByText("Compile release")).toBeTruthy();
		expect(
			screen.getByText("processed · delivery complete · work finished"),
		).toBeTruthy();
		expect(screen.getByText("Phone: displayed")).toBeTruthy();
		expect(screen.getByText("Desktop: suppressed · quiet hours")).toBeTruthy();
		expect(
			screen.getByText((content) =>
				content.startsWith("Tablet: queued · quiet hours · next "),
			),
		).toBeTruthy();
		expect(getPushNotificationHistory).toHaveBeenCalledWith(20);
		expect(
			screen.getByText("Compile release").closest("li")?.className,
		).toContain("min-w-0");
		const historyRegion = screen.getByRole("region", {
			name: "Recent notification history",
		});
		expect(historyRegion.getAttribute("tabindex")).toBe("0");
		expect(historyRegion.getAttribute("aria-busy")).toBe("false");
		expect(historyRegion.className).toContain("max-h-[min(24rem,50svh)]");
		expect(historyRegion.className).toContain("overflow-y-auto");
		expect(historyRegion.className).toContain("touch-pan-y");
		expect(historyRegion.className).toContain("focus-visible:ring-1");
		expect(historyRegion.firstElementChild?.tagName).toBe("OL");
	});

	it("describes foreground suppression without implying work was cancelled", async () => {
		const occurredAt = new Date(2026, 0, 2, 12).getTime();
		const expiresAt = new Date(2026, 0, 3, 12).getTime();
		vi.mocked(getPushNotificationHistory).mockResolvedValue([
			{
				id: "88888888-8888-4888-8888-888888888888",
				sourceKind: "session",
				sourceId: "session-complete",
				category: "completion",
				reason: "work_finished",
				label: "Finished session",
				url: "/raven?session=session-complete",
				runtimeMs: 30_000,
				pendingCount: 0,
				occurredAt,
				expiresAt,
				groupKey: "completion",
				batchId: null,
				status: "cancelled",
				statusReason: "app_focused",
				nextAttemptAt: null,
				deliveries: [],
			},
			{
				id: "99999999-9999-4999-8999-999999999999",
				sourceKind: "session",
				sourceId: "session-request",
				category: "request",
				reason: "permission_required",
				label: "Waiting session",
				url: "/raven?session=session-request",
				runtimeMs: null,
				pendingCount: 1,
				occurredAt,
				expiresAt,
				groupKey: null,
				batchId: null,
				status: "deferred",
				statusReason: "app_focused",
				nextAttemptAt: occurredAt + 15_000,
				deliveries: [],
			},
		]);

		render(<NotificationsSection />);

		expect(
			await screen.findByText("suppressed · Hlið was focused"),
		).toBeTruthy();
		expect(screen.getByText("deferred · Hlið is focused")).toBeTruthy();
		expect(screen.queryByText(/cancelled · app focused/i)).toBeNull();
	});

	it("keeps history retry separate from device and opt-in controls", async () => {
		vi.mocked(getPushNotificationHistory)
			.mockRejectedValueOnce(new Error("History unavailable."))
			.mockResolvedValueOnce([]);

		render(<NotificationsSection />);

		expect(await screen.findByText("History unavailable.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "REFRESH HISTORY" }));
		await waitFor(() =>
			expect(getPushNotificationHistory).toHaveBeenCalledTimes(2),
		);
		expect(
			screen.getByRole("button", { name: "ENABLE ON THIS DEVICE" }),
		).toBeTruthy();
	});

	it("refreshes notification history while the settings are healthy", async () => {
		render(<NotificationsSection />);

		expect(
			await screen.findByText("No notification history yet."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "REFRESH HISTORY" }));
		await waitFor(() =>
			expect(getPushNotificationHistory).toHaveBeenCalledTimes(2),
		);
	});

	it("stays off and does not prompt until Enable is clicked", async () => {
		render(<NotificationsSection />);

		const enable = await screen.findByRole("button", {
			name: "ENABLE ON THIS DEVICE",
		});
		expect(screen.getByText("Not requested")).toBeTruthy();
		expect(enablePushNotifications).not.toHaveBeenCalled();
		expect(
			(
				screen.getByRole("checkbox", {
					name: "Request notifications",
				}) as HTMLInputElement
			).disabled,
		).toBe(true);

		fireEvent.click(enable);

		await waitFor(() => expect(enablePushNotifications).toHaveBeenCalledOnce());
		expect(
			await screen.findByRole("button", { name: "DISABLE ON THIS DEVICE" }),
		).toBeTruthy();
	});

	it("saves request, problem, completion, and detail controls", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		render(<NotificationsSection />);
		const completionMinimum = await screen.findByRole("combobox", {
			name: /Completion minimum runtime/i,
		});
		expect(
			(completionMinimum as HTMLSelectElement).selectedOptions[0]?.textContent,
		).toBe("No minimum");

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Request notifications" }),
		);
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				...enabledState.preferences,
				requests: false,
			}),
		);

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Work finished notifications" }),
		);
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				...enabledState.preferences,
				requests: false,
				workFinished: true,
			}),
		);

		fireEvent.change(
			screen.getByRole("combobox", { name: /Completion minimum runtime/i }),
			{ target: { value: "5" } },
		);
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				...enabledState.preferences,
				requests: false,
				workFinished: true,
				completionMinimumMinutes: 5,
			}),
		);

		fireEvent.change(
			screen.getByRole("combobox", { name: /Lock Screen wording/i }),
			{ target: { value: "detailed" } },
		);
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				...enabledState.preferences,
				requests: false,
				workFinished: true,
				completionMinimumMinutes: 5,
				detail: "detailed",
			}),
		);
	});

	it("preserves an unsaved quiet-hours draft across equal server refreshes", async () => {
		const quietHours: PushNotificationQuietHours = {
			timezone: "America/New_York",
			start: "22:00",
			end: "07:00",
			weekdays: [1, 2, 3, 4, 5],
			allowRequests: true,
			allowProblems: true,
		};
		const quietState = {
			...enabledState,
			preferences: { ...enabledState.preferences, quietHours },
		};
		vi.mocked(getPushNotificationState).mockResolvedValue(quietState);
		vi.mocked(updatePushNotificationPreferences).mockImplementation(
			async (preferences) => ({
				...quietState,
				preferences: {
					...preferences,
					quietHours: preferences.quietHours
						? {
								...preferences.quietHours,
								weekdays: [...preferences.quietHours.weekdays],
							}
						: null,
				},
			}),
		);
		render(<NotificationsSection />);

		const start = await screen.findByLabelText(
			"Current device quiet hours start",
		);
		fireEvent.change(start, { target: { value: "23:00" } });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Request notifications" }),
		);

		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenCalled(),
		);
		expect((start as HTMLInputElement).value).toBe("23:00");
		expect(
			screen.getByRole("button", { name: "SAVE QUIET HOURS" }),
		).toBeTruthy();
	});

	it("saves recurring quiet hours without catch-up controls", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		render(<NotificationsSection />);

		expect(
			await screen.findByRole("checkbox", {
				name: "Current device quiet hours",
			}),
		).toBeTruthy();
		expect(
			screen.queryByRole("checkbox", { name: "Catch up after a pause" }),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("checkbox", { name: "Current device quiet hours" }),
		);
		fireEvent.change(
			screen.getByLabelText("Current device quiet hours timezone"),
			{ target: { value: "America/New_York" } },
		);
		fireEvent.change(
			screen.getByLabelText("Current device quiet hours start"),
			{
				target: { value: "23:00" },
			},
		);
		fireEvent.change(screen.getByLabelText("Current device quiet hours end"), {
			target: { value: "06:00" },
		});
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Current device quiet hours Sun" }),
		);
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Current device allow requests during quiet hours",
			}),
		);
		expect(
			screen.queryByRole("checkbox", {
				name: "Current device catch up after quiet hours",
			}),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "SAVE QUIET HOURS" }));

		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				...enabledState.preferences,
				quietHours: {
					timezone: "America/New_York",
					start: "23:00",
					end: "06:00",
					weekdays: [1, 2, 3, 4, 5, 6],
					allowRequests: false,
					allowProblems: true,
				},
			}),
		);
	});

	it("edits a remote device's complete notification profile without endpoint data", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices).mockResolvedValue([desktop]);
		render(<NotificationsSection />);

		fireEvent.click(await screen.findByText("EDIT NOTIFICATION PROFILE"));
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Desktop request notifications" }),
		);
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Desktop work finished notifications",
			}),
		);
		fireEvent.change(
			screen.getByRole("combobox", {
				name: "Desktop completion minimum runtime",
			}),
			{ target: { value: "5" } },
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Desktop lock screen wording" }),
			{ target: { value: "detailed" } },
		);
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Desktop quiet hours" }),
		);
		fireEvent.change(screen.getByLabelText("Desktop quiet hours timezone"), {
			target: { value: "UTC" },
		});
		fireEvent.click(
			screen.getByRole("checkbox", {
				name: "Desktop allow problems during quiet hours",
			}),
		);
		const save = screen.getByRole("button", {
			name: "Save notification profile for Desktop",
		});
		expect(save.className).toContain("min-h-11");
		fireEvent.click(save);

		await waitFor(() =>
			expect(updatePushNotificationDevice).toHaveBeenCalledWith(desktop.id, {
				preferences: {
					requests: false,
					problems: true,
					workFinished: true,
					detail: "detailed",
					completionMinimumMinutes: 5,
					quietHours: {
						timezone: "UTC",
						start: "22:00",
						end: "07:00",
						weekdays: [1, 2, 3, 4, 5, 6, 7],
						allowRequests: true,
						allowProblems: false,
					},
				},
			}),
		);
		expect(
			JSON.stringify(vi.mocked(updatePushNotificationDevice).mock.calls),
		).not.toContain("endpoint");
	});

	it("preserves an unsaved remote profile across an equal server refresh", async () => {
		const renamedDesktop = {
			...desktop,
			name: "Desk",
			preferences: { ...desktop.preferences },
		};
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices)
			.mockResolvedValueOnce([desktop])
			.mockResolvedValue([renamedDesktop]);
		render(<NotificationsSection />);

		fireEvent.click(await screen.findByText("EDIT NOTIFICATION PROFILE"));
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Desktop request notifications" }),
		);
		fireEvent.change(
			screen.getByRole("textbox", { name: "Name for Desktop" }),
			{
				target: { value: "Desk" },
			},
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Save name for Desktop" }),
		);

		const requestToggle = await screen.findByRole("checkbox", {
			name: "Desk request notifications",
		});
		expect((requestToggle as HTMLInputElement).checked).toBe(false);
		expect(getPushNotificationDevices).toHaveBeenCalledTimes(2);
	});

	it("pauses for a chosen duration, exact time, or manual resume", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		render(<NotificationsSection />);

		fireEvent.change(await screen.findByLabelText("Pause duration"), {
			target: { value: "2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "PAUSE FOR" }));
		await waitFor(() => expect(pausePushNotifications).toHaveBeenCalledOnce());
		const twoHours = vi.mocked(pausePushNotifications).mock.calls[0][0];
		expect(twoHours).toBeTypeOf("number");
		expect((twoHours as number) - Date.now()).toBeGreaterThan(7_190_000);
		fireEvent.click(await screen.findByRole("button", { name: "RESUME" }));
		await waitFor(() =>
			expect(pausePushNotifications).toHaveBeenLastCalledWith(null),
		);

		const exactLocalTime = "2030-06-12T14:45";
		fireEvent.change(
			await screen.findByLabelText("Pause until date and time"),
			{
				target: { value: exactLocalTime },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "PAUSE UNTIL" }));
		await waitFor(() =>
			expect(pausePushNotifications).toHaveBeenCalledTimes(3),
		);
		expect(pausePushNotifications).toHaveBeenLastCalledWith(
			new Date(exactLocalTime).getTime(),
		);
		fireEvent.click(await screen.findByRole("button", { name: "RESUME" }));
		await waitFor(() =>
			expect(pausePushNotifications).toHaveBeenCalledTimes(4),
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "UNTIL I RESUME" }),
		);
		await waitFor(() =>
			expect(pausePushNotifications).toHaveBeenLastCalledWith("indefinite"),
		);
	});

	it("stops showing an expired pause without requiring another interaction", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 2, 12));
		vi.mocked(getPushNotificationState).mockResolvedValue({
			...enabledState,
			pausedUntil: Date.now() + 1_000,
		});
		render(<NotificationsSection />);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(screen.getByRole("button", { name: "RESUME" })).toBeTruthy();

		act(() => vi.advanceTimersByTime(1_025));

		expect(screen.queryByRole("button", { name: "RESUME" })).toBeNull();
		expect(screen.getByRole("button", { name: "PAUSE FOR" })).toBeTruthy();
	});

	it("keeps a manual pause active until Resume is chosen", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue({
			...enabledState,
			pausedIndefinitely: true,
		});
		render(<NotificationsSection />);

		expect(await screen.findByRole("button", { name: "RESUME" })).toBeTruthy();
		expect(screen.getByText(/paused until you manually resume/i)).toBeTruthy();
		expect(screen.queryByLabelText("Pause duration")).toBeNull();
	});

	it("reports test acceptance truthfully and refreshes delivery health", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices)
			.mockResolvedValueOnce([phone])
			.mockResolvedValueOnce([desktop]);
		render(<NotificationsSection />);
		fireEvent.change(await screen.findByLabelText("Test notification form"), {
			target: { value: "problem" },
		});

		fireEvent.click(
			await screen.findByRole("button", { name: "SEND SELECTED PREVIEW" }),
		);
		await waitFor(() =>
			expect(sendTestPushNotification).toHaveBeenCalledWith("problem"),
		);

		expect(
			await screen.findByText(/Accepted by the push service at/),
		).toBeTruthy();
		expect(
			screen.getByText(/Display is controlled by this device/),
		).toBeTruthy();
		expect(await screen.findByText(/2 failed attempts/)).toBeTruthy();
	});

	it("shows the newest health result rather than an older historical failure", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices).mockResolvedValue([
			{
				...phone,
				lastFailureAt: new Date(2026, 0, 1, 12).getTime(),
				lastAcceptedAt: new Date(2026, 0, 2, 12).getTime(),
				failureCount: 3,
			},
		]);
		render(<NotificationsSection />);

		expect(await screen.findByText(/Last accepted/)).toBeTruthy();
		expect(screen.queryByText(/3 failed attempts/)).toBeNull();
	});

	it("treats a same-second acceptance with cleared failure count as healthy", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		const tiedAt = new Date(2026, 0, 2, 12).getTime();
		vi.mocked(getPushNotificationDevices).mockResolvedValue([
			{
				...phone,
				lastFailureAt: tiedAt,
				lastAcceptedAt: tiedAt,
				failureCount: 0,
			},
		]);
		render(<NotificationsSection />);

		expect(await screen.findByText(/Last accepted/)).toBeTruthy();
		expect(screen.queryByText(/failed attempt/)).toBeNull();
	});

	it("refreshes into Repair when a test invalidates this subscription", async () => {
		vi.mocked(getPushNotificationState)
			.mockResolvedValueOnce(enabledState)
			.mockResolvedValueOnce({
				...enabledState,
				enabled: false,
				reenableRequired: true,
			});
		vi.mocked(sendTestPushNotification).mockResolvedValue({
			accepted: false,
			acceptedAt: null,
			failureAt: Date.now(),
			failureCount: 1,
			subscriptionRemoved: true,
		});
		render(<NotificationsSection />);

		fireEvent.click(
			await screen.findByRole("button", { name: "SEND SELECTED PREVIEW" }),
		);

		expect(
			await screen.findByRole("button", { name: "REPAIR ON THIS DEVICE" }),
		).toBeTruthy();
		expect(
			screen.getByText(/push service rejected this subscription/i),
		).toBeTruthy();
	});

	it("renames and revokes remote devices but locally disables this device", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices).mockResolvedValue([phone, desktop]);
		render(<NotificationsSection />);

		const desktopName = await screen.findByLabelText("Name for Desktop");
		expect(
			screen.getByRole("button", { name: "Revoke Desktop" }).parentElement
				?.className,
		).toContain("flex-wrap");
		fireEvent.change(desktopName, { target: { value: "Office" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Save name for Desktop" }),
		);
		await waitFor(() =>
			expect(renamePushNotificationDevice).toHaveBeenCalledWith(
				desktop.id,
				"Office",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Revoke Desktop" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm revoke Desktop" }),
		);
		await waitFor(() =>
			expect(revokePushNotificationDevice).toHaveBeenCalledWith(desktop.id),
		);
		expect(disablePushNotifications).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Revoke Phone" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm revoke Phone" }),
		);
		await waitFor(() => expect(disablePushNotifications).toHaveBeenCalled());
	});

	it("re-lists after renaming this device before choosing local revoke", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices).mockResolvedValue([phone]);
		vi.mocked(renamePushNotificationDevice).mockResolvedValue({
			...phone,
			name: "Renamed phone",
			current: false,
		});
		render(<NotificationsSection />);

		const name = await screen.findByLabelText("Name for Phone");
		fireEvent.change(name, { target: { value: "Renamed phone" } });
		fireEvent.click(
			screen.getByRole("button", { name: "Save name for Phone" }),
		);
		await waitFor(() =>
			expect(getPushNotificationDevices).toHaveBeenCalledTimes(2),
		);
		fireEvent.click(screen.getByRole("button", { name: "Revoke Phone" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm revoke Phone" }),
		);
		await waitFor(() => expect(disablePushNotifications).toHaveBeenCalled());
		expect(revokePushNotificationDevice).not.toHaveBeenCalled();
	});

	it("explains unsupported contexts without asking for permission", async () => {
		vi.mocked(getPushNotificationSupport).mockReturnValue({
			supported: false,
			reason: "push-unavailable",
		});

		render(<NotificationsSection />);

		expect(
			await screen.findByText("Notifications are unavailable here"),
		).toBeTruthy();
		expect(
			screen.getByText("This browser does not support Web Push."),
		).toBeTruthy();
		expect(getPushNotificationState).not.toHaveBeenCalled();
		expect(getPushNotificationDevices).toHaveBeenCalledOnce();
		expect(enablePushNotifications).not.toHaveBeenCalled();
	});

	it("keeps remote device revocation available in an unsupported browser", async () => {
		vi.mocked(getPushNotificationSupport).mockReturnValue({
			supported: false,
			reason: "push-unavailable",
		});
		vi.mocked(getPushNotificationDevices).mockResolvedValue([desktop]);
		render(<NotificationsSection />);

		await screen.findByText("Notifications are unavailable here");
		fireEvent.click(
			await screen.findByRole("button", { name: "Revoke Desktop" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Confirm revoke Desktop" }),
		);

		await waitFor(() =>
			expect(revokePushNotificationDevice).toHaveBeenCalledWith(desktop.id),
		);
		expect(getPushNotificationState).not.toHaveBeenCalled();
		expect(disablePushNotifications).not.toHaveBeenCalled();
	});

	it("preserves current-device controls when device management fails", async () => {
		vi.mocked(getPushNotificationDevices).mockRejectedValue(
			new Error("Device list unavailable."),
		);
		render(<NotificationsSection />);

		expect(
			await screen.findByRole("button", { name: "ENABLE ON THIS DEVICE" }),
		).toBeTruthy();
		expect(await screen.findByText("Device list unavailable.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "RETRY DEVICES" })).toBeTruthy();
	});

	it("does not turn accepted test delivery into failure when device refresh fails", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		vi.mocked(getPushNotificationDevices)
			.mockResolvedValueOnce([phone])
			.mockRejectedValueOnce(new Error("Health refresh unavailable."));
		render(<NotificationsSection />);

		fireEvent.click(
			await screen.findByRole("button", { name: "SEND SELECTED PREVIEW" }),
		);

		expect(
			await screen.findByText(/Accepted by the push service at/),
		).toBeTruthy();
		expect(await screen.findByText("Health refresh unavailable.")).toBeTruthy();
		expect(
			screen.queryByText("Could not send a test notification."),
		).toBeNull();
	});

	it("keeps Repair actionable after the first WebKit-safe repair tap", async () => {
		const repairState = {
			...enabledState,
			enabled: false,
			reenableRequired: true,
		};
		vi.mocked(getPushNotificationState).mockResolvedValue(repairState);
		vi.mocked(enablePushNotifications).mockRejectedValue(
			Object.assign(
				new Error("Old subscription removed. Tap Repair again to finish."),
				{ code: "repair-ready" },
			),
		);
		render(<NotificationsSection />);

		fireEvent.click(
			await screen.findByRole("button", { name: "REPAIR ON THIS DEVICE" }),
		);

		expect(
			await screen.findByText(
				"Old subscription removed. Tap Repair again to finish.",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "REPAIR ON THIS DEVICE" }),
		).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows how to recover when browser permission is blocked", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue({
			...disabledState,
			permission: "denied",
		});
		render(<NotificationsSection />);

		const enable = await screen.findByRole("button", {
			name: "ENABLE ON THIS DEVICE",
		});
		expect((enable as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("Blocked by this browser")).toBeTruthy();
		expect(
			screen.getByText(
				/allow notifications in this browser or device's settings/i,
			),
		).toBeTruthy();
	});

	it("refreshes permission state when the enable prompt is denied", async () => {
		vi.mocked(enablePushNotifications).mockRejectedValue(
			new Error("Notification permission was not granted."),
		);
		vi.mocked(getPushNotificationState)
			.mockResolvedValueOnce(disabledState)
			.mockResolvedValueOnce({ ...disabledState, permission: "denied" });
		render(<NotificationsSection />);

		fireEvent.click(
			await screen.findByRole("button", { name: "ENABLE ON THIS DEVICE" }),
		);

		await screen.findByText("Blocked by this browser");
		expect(
			screen.getByText("Notification permission was not granted."),
		).toBeTruthy();
	});
});
