// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAloud = vi.hoisted(() => ({
	state: {
		messageId: null as string | null,
		phase: "idle" as "idle" | "loading" | "speaking" | "paused" | "error",
		error: null as string | null,
	},
	preferences: {
		provider: "device" as "device" | "microsoft" | "neural" | "codex",
	},
	readAloudSupported: vi.fn(() => true),
	stopReadAloud: vi.fn(),
	stopReadAloudMessage: vi.fn(),
	toggleReadAloud: vi.fn(),
}));

vi.mock("#/hooks/readAloudStore", () => ({
	readAloudSupported: readAloud.readAloudSupported,
	stopReadAloud: readAloud.stopReadAloud,
	stopReadAloudMessage: readAloud.stopReadAloudMessage,
	toggleReadAloud: readAloud.toggleReadAloud,
	useReadAloudPreferences: () => readAloud.preferences,
	useReadAloudState: () => readAloud.state,
}));

import { ReadAloudButton } from "./ReadAloudButton";

beforeEach(() => {
	vi.clearAllMocks();
	readAloud.state = { messageId: null, phase: "idle", error: null };
	readAloud.preferences = { provider: "device" };
	readAloud.readAloudSupported.mockReturnValue(true);
});

afterEach(cleanup);

describe("ReadAloudButton", () => {
	it("identifies Codex realtime and starts the selected response", async () => {
		readAloud.preferences = { provider: "codex" };
		render(
			<ReadAloudButton messageId="message-1" text="Read this" dbId={42} />,
		);

		const button = await screen.findByRole("button", { name: "Read aloud" });
		await waitFor(() =>
			expect((button as HTMLButtonElement).disabled).toBe(false),
		);
		expect(button.title).toBe("Read aloud using Codex realtime");

		fireEvent.click(button);
		expect(readAloud.toggleReadAloud).toHaveBeenCalledWith(
			"message-1",
			"Read this",
			42,
		);
	});

	it("makes a failed attempt visible and retryable", async () => {
		readAloud.preferences = { provider: "codex" };
		readAloud.state = {
			messageId: "message-1",
			phase: "error",
			error: "Codex read aloud failed: Audio playback was blocked",
		};
		render(<ReadAloudButton messageId="message-1" text="Read this" />);

		const button = await screen.findByRole("button", {
			name: "Retry read aloud",
		});
		await waitFor(() =>
			expect((button as HTMLButtonElement).disabled).toBe(false),
		);
		expect(button.title).toBe(
			"Codex read aloud failed: Audio playback was blocked",
		);
		expect(button.className).toContain("text-destructive/70");
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(
			"Codex read aloud failed: Audio playback was blocked",
		);
		expect(button.getAttribute("aria-describedby")).toBe(alert.id);
	});

	it("expands the full error without retrying and resets for a new error", async () => {
		readAloud.preferences = { provider: "codex" };
		readAloud.state = {
			messageId: "message-1",
			phase: "error",
			error:
				"Codex read aloud failed: Audio playback was blocked by the mobile browser",
		};
		const { rerender } = render(
			<ReadAloudButton messageId="message-1" text="Read this" />,
		);

		const disclosure = await screen.findByRole("button", {
			name: "Show full read aloud error",
		});
		const alert = screen.getByRole("alert");
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		expect(alert.className).toContain("truncate");

		fireEvent.click(disclosure);

		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(disclosure.getAttribute("aria-label")).toBe(
			"Collapse read aloud error",
		);
		expect(alert.className).toContain("whitespace-normal");
		expect(alert.className).toContain("break-words");
		expect(readAloud.toggleReadAloud).not.toHaveBeenCalled();

		readAloud.state = {
			messageId: "message-1",
			phase: "error",
			error: "Codex read aloud failed: A different playback error",
		};
		rerender(<ReadAloudButton messageId="message-1" text="Read this" />);

		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Show full read aloud error" })
					.getAttribute("aria-expanded"),
			).toBe("false"),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Show full read aloud error" }),
		);
		readAloud.state = {
			messageId: "message-2",
			phase: "error",
			error: "Codex read aloud failed: A new response failed",
		};
		rerender(<ReadAloudButton messageId="message-2" text="Read another" />);

		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Show full read aloud error" })
					.getAttribute("aria-expanded"),
			).toBe("false"),
		);
	});

	it("shows one truthful stop control while Codex is streaming", async () => {
		readAloud.preferences = { provider: "codex" };
		readAloud.state = {
			messageId: "message-1",
			phase: "speaking",
			error: null,
		};
		render(<ReadAloudButton messageId="message-1" text="Read this" />);

		const button = await screen.findByRole("button", { name: "Stop reading" });
		expect(screen.getAllByRole("button")).toHaveLength(1);
		fireEvent.click(button);
		expect(readAloud.toggleReadAloud).toHaveBeenCalledWith(
			"message-1",
			"Read this",
			undefined,
		);
		expect(readAloud.stopReadAloud).not.toHaveBeenCalled();
	});
});
