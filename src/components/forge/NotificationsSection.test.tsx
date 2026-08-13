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
	getPushNotificationState,
	getPushNotificationSupport,
	pausePushNotifications,
	renamePushNotificationDevice,
	revokePushNotificationDevice,
	sendTestPushNotification,
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
	getPushNotificationState: vi.fn(),
	getPushNotificationSupport: vi.fn(),
	pausePushNotifications: vi.fn(),
	renamePushNotificationDevice: vi.fn(),
	revokePushNotificationDevice: vi.fn(),
	sendTestPushNotification: vi.fn(),
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

		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Request notifications" }),
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
