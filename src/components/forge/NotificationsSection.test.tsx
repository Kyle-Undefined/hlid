// @vitest-environment jsdom
import {
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
	getPushNotificationState,
	getPushNotificationSupport,
	updatePushNotificationPreferences,
} from "#/lib/pushNotifications";
import { NotificationsSection } from "./NotificationsSection";

vi.mock("#/lib/pushNotifications", () => ({
	disablePushNotifications: vi.fn(),
	enablePushNotifications: vi.fn(),
	getPushNotificationState: vi.fn(),
	getPushNotificationSupport: vi.fn(),
	updatePushNotificationPreferences: vi.fn(),
}));

const disabledState = {
	supported: true as const,
	permission: "default" as const,
	enabled: false,
	preferences: {
		needsAttention: true,
		workFinished: false,
		detail: "generic" as const,
	},
};

const enabledState = {
	...disabledState,
	permission: "granted" as const,
	enabled: true,
};

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPushNotificationSupport).mockReturnValue({ supported: true });
	vi.mocked(getPushNotificationState).mockResolvedValue(disabledState);
	vi.mocked(enablePushNotifications).mockResolvedValue(enabledState);
	vi.mocked(disablePushNotifications).mockResolvedValue({
		...enabledState,
		enabled: false,
	});
	vi.mocked(updatePushNotificationPreferences).mockImplementation(
		async (preferences) => ({ ...enabledState, preferences }),
	);
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
					name: /Needs attention/i,
				}) as HTMLInputElement
			).disabled,
		).toBe(true);

		fireEvent.click(enable);

		await waitFor(() => expect(enablePushNotifications).toHaveBeenCalledOnce());
		expect(
			await screen.findByRole("button", { name: "DISABLE ON THIS DEVICE" }),
		).toBeTruthy();
	});

	it("saves event types and Lock Screen wording for the enabled device", async () => {
		vi.mocked(getPushNotificationState).mockResolvedValue(enabledState);
		render(<NotificationsSection />);

		const completion = await screen.findByRole("checkbox", {
			name: /Work finished/i,
		});
		fireEvent.click(completion);
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenCalledWith({
				needsAttention: true,
				workFinished: true,
				detail: "generic",
			}),
		);

		fireEvent.change(screen.getByRole("combobox", { name: /Lock Screen/i }), {
			target: { value: "detailed" },
		});
		await waitFor(() =>
			expect(updatePushNotificationPreferences).toHaveBeenLastCalledWith({
				needsAttention: true,
				workFinished: true,
				detail: "detailed",
			}),
		);
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
		expect(enablePushNotifications).not.toHaveBeenCalled();
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
