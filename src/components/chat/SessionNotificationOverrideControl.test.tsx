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
	getSessionNotificationOverride,
	setSessionNotificationOverride,
} from "#/lib/pushNotifications";
import { SessionNotificationOverrideControl } from "./SessionNotificationOverrideControl";

vi.mock("#/lib/pushNotifications", () => ({
	getSessionNotificationOverride: vi.fn(),
	setSessionNotificationOverride: vi.fn(),
}));

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getSessionNotificationOverride).mockResolvedValue("default");
	vi.mocked(setSessionNotificationOverride).mockImplementation(
		async (_sessionId, mode) => mode,
	);
});

describe("SessionNotificationOverrideControl", () => {
	it("loads the current override without changing it", async () => {
		render(<SessionNotificationOverrideControl sessionId="session 1" />);

		expect(
			screen.getByLabelText("Loading session notification setting"),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: /Default/ })
					.getAttribute("aria-pressed"),
			).toBe("true"),
		);
		expect(getSessionNotificationOverride).toHaveBeenCalledWith("session 1");
		expect(setSessionNotificationOverride).not.toHaveBeenCalled();
	});

	it("saves Notify as a session-global override", async () => {
		render(<SessionNotificationOverrideControl sessionId="session-2" />);
		const notify = await screen.findByRole("button", { name: /Notify/ });
		expect(
			screen.getByText(
				"Always send this session's eligible alerts to subscribed devices.",
			),
		).toBeTruthy();

		fireEvent.click(notify);

		await waitFor(() =>
			expect(setSessionNotificationOverride).toHaveBeenCalledWith(
				"session-2",
				"notify",
			),
		);
		expect(notify.getAttribute("aria-pressed")).toBe("true");
		expect(
			screen.getByText("Applies to this session on every device."),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Always send this session's eligible alerts to subscribed devices.",
			),
		).toBeTruthy();
	});

	it("restores the previous choice when saving fails", async () => {
		vi.mocked(setSessionNotificationOverride).mockRejectedValue(
			new Error("Save failed"),
		);
		render(<SessionNotificationOverrideControl sessionId="session-3" />);
		const mute = await screen.findByRole("button", { name: /Mute/ });

		fireEvent.click(mute);

		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toContain("Save failed");
		expect(
			screen
				.getByRole("button", { name: /Default/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});
});
