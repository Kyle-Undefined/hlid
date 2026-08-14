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
	getPushNotificationBatch,
	markPushNotificationBatchRead,
	type PushNotificationBatchState,
} from "#/lib/pushNotifications";
import { NotificationBatchDrawer } from "./NotificationBatchDrawer";

vi.mock("#/lib/pushNotifications", () => ({
	getPushNotificationBatch: vi.fn(),
	markPushNotificationBatchRead: vi.fn(),
}));

const firstEvent = {
	id: "33333333-3333-4333-8333-333333333333",
	sourceKind: "session" as const,
	sourceId: "session-1",
	category: "completion" as const,
	reason: "work_finished",
	label: "Compile release",
	url: "/raven?session=session-1",
	runtimeMs: 30_000,
	pendingCount: 0,
	occurredAt: new Date(2026, 0, 2, 12).getTime(),
	expiresAt: new Date(2026, 0, 3, 12).getTime(),
	groupKey: "completion",
	batchId: "batch-one",
	status: "batched" as const,
	statusReason: null,
	nextAttemptAt: null,
};

function batchState(): PushNotificationBatchState {
	return {
		batch: {
			id: "batch-one",
			category: "completion",
			groupKey: "completion",
			status: "sent",
			createdAt: new Date(2026, 0, 2, 12).getTime(),
			updatedAt: new Date(2026, 0, 2, 12, 1).getTime(),
			sentAt: new Date(2026, 0, 2, 12, 1).getTime(),
			readAt: null,
		},
		members: [
			{
				eventId: "55555555-5555-4555-8555-555555555555",
				sessionId: "session-2",
				position: 1,
				addedAt: new Date(2026, 0, 2, 12, 0, 1).getTime(),
				readAt: null,
				event: {
					...firstEvent,
					id: "55555555-5555-4555-8555-555555555555",
					sourceId: "session-2",
					label: "Run checks",
				},
			},
			{
				eventId: firstEvent.id,
				sessionId: "session-1",
				position: 0,
				addedAt: firstEvent.occurredAt,
				readAt: null,
				event: firstEvent,
			},
		],
	};
}

afterEach(cleanup);

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPushNotificationBatch).mockResolvedValue(batchState());
	vi.mocked(markPushNotificationBatchRead).mockResolvedValue(
		new Date(2026, 0, 2, 12, 2).getTime(),
	);
});

describe("NotificationBatchDrawer", () => {
	it("shows ordered members and marks the exact opened session read", async () => {
		const onOpenSession = vi.fn();
		render(
			<NotificationBatchDrawer
				batchId="batch-one"
				onClose={vi.fn()}
				onOpenSession={onOpenSession}
			/>,
		);

		const dialog = screen.getByRole("dialog", { name: "Finished work" });
		expect(dialog.className).toContain("inset-x-3");
		const openButtons = await screen.findAllByRole("button", {
			name: /^Open /,
		});
		expect(
			openButtons.map((button) => button.getAttribute("aria-label")),
		).toEqual(["Open Compile release", "Open Run checks"]);
		expect(screen.getByText("2 sessions · 2 unread")).toBeTruthy();

		fireEvent.click(openButtons[0]);

		await waitFor(() =>
			expect(markPushNotificationBatchRead).toHaveBeenCalledWith(
				"batch-one",
				"session-1",
			),
		);
		expect(onOpenSession).toHaveBeenCalledWith("session-1");
		expect(screen.getByText("2 sessions · 1 unread")).toBeTruthy();
		expect(screen.getAllByText("Read")).toHaveLength(1);
	});

	it("marks every member read without changing sessions", async () => {
		const onOpenSession = vi.fn();
		render(
			<NotificationBatchDrawer
				batchId="batch-one"
				onClose={vi.fn()}
				onOpenSession={onOpenSession}
			/>,
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Mark all read" }),
		);

		await waitFor(() =>
			expect(markPushNotificationBatchRead).toHaveBeenCalledWith("batch-one"),
		);
		expect(screen.getByText("2 sessions · 0 unread")).toBeTruthy();
		expect(screen.getAllByText("Read")).toHaveLength(2);
		expect(onOpenSession).not.toHaveBeenCalled();
		expect(
			(
				screen.getByRole("button", {
					name: "Mark all read",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("keeps the drawer open when marking an opened member read fails", async () => {
		const onOpenSession = vi.fn();
		vi.mocked(markPushNotificationBatchRead).mockRejectedValueOnce(
			new Error("Read state unavailable."),
		);
		render(
			<NotificationBatchDrawer
				batchId="batch-one"
				onClose={vi.fn()}
				onOpenSession={onOpenSession}
			/>,
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Open Compile release" }),
		);
		expect(await screen.findByText("Read state unavailable.")).toBeTruthy();
		expect(onOpenSession).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", { name: "Open Compile release" }),
		);
		await waitFor(() =>
			expect(onOpenSession).toHaveBeenCalledWith("session-1"),
		);
	});

	it("offers retry and closes with Escape", async () => {
		const onClose = vi.fn();
		vi.mocked(getPushNotificationBatch)
			.mockRejectedValueOnce(new Error("Batch unavailable."))
			.mockResolvedValueOnce(batchState());
		render(
			<NotificationBatchDrawer
				batchId="batch-one"
				onClose={onClose}
				onOpenSession={vi.fn()}
			/>,
		);

		expect(await screen.findByText("Batch unavailable.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("button", { name: "Open Compile release" }),
		).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});
});
