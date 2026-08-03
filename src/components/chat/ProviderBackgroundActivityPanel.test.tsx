// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	replaceSessionsStatus,
	resetSessionStatusForTesting,
} from "#/hooks/wsSessionStatusStore";
import type { SessionStatusEntry } from "#/server/protocol";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn(() => true) }));

vi.mock("#/hooks/wsStore", () => ({ send: mockSend }));

import { ProviderBackgroundActivityPanel } from "./ProviderBackgroundActivityPanel";

afterEach(cleanup);

beforeEach(() => {
	resetSessionStatusForTesting();
	mockSend.mockClear();
});

function status(): SessionStatusEntry {
	return {
		session_id: "pool-1",
		agent_cwd: "/tmp/project",
		agent_name: "Test",
		state: "idle",
		provider_id: "codex",
		model: "gpt-test",
		hasPendingPermissions: false,
		hasDbSession: true,
		db_session_id: "session-1",
		background_activities: [
			{
				providerId: "codex",
				providerSessionId: "thread-1",
				activityId: "item-1",
				processId: "process-1",
				kind: "terminal",
				status: "running",
				command: "python3 -m http.server",
				cwd: "/tmp/project",
				recentOutput: "Serving on 8000",
				startedAtMs: 1,
				updatedAtMs: 2,
				capabilities: { terminate: true, clean: true },
			},
		],
	};
}

describe("ProviderBackgroundActivityPanel", () => {
	it("renders a collapsed live summary and terminates the exact native item", () => {
		act(() => replaceSessionsStatus([status()]));
		render(<ProviderBackgroundActivityPanel sessionId="session-1" />);

		expect(screen.queryByText("python3 -m http.server")).toBeNull();
		const toggle = screen.getByRole("button", {
			name: /BACKGROUND ACTIVITY/i,
		});
		if (toggle.getAttribute("aria-expanded") !== "true") {
			fireEvent.click(toggle);
		}
		expect(screen.getByText("python3 -m http.server")).not.toBeNull();
		expect(screen.getByText("Serving on 8000")).not.toBeNull();
		const listClasses = screen.getByTestId(
			"provider-background-activity-list",
		).className;
		expect(listClasses).toContain("max-h-56");
		expect(listClasses).toContain("overflow-y-auto");
		expect(listClasses).toContain("overscroll-contain");
		expect(screen.getByText("python3 -m http.server").className).toContain(
			"truncate",
		);
		expect(screen.getByText("Serving on 8000").className).toContain(
			"line-clamp-2",
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Stop background activity" }),
		);

		expect(mockSend).toHaveBeenCalledWith({
			type: "background_activity_control",
			action: "terminate",
			activity_id: "item-1",
			session_id: "pool-1",
		});
	});

	it("hides persisted non-live activity because the panel is live-only", () => {
		const restored = status();
		if (restored.background_activities?.[0]) {
			restored.background_activities[0] = {
				...restored.background_activities[0],
				status: "unknown",
				capabilities: {},
			};
		}
		act(() => replaceSessionsStatus([restored]));
		render(<ProviderBackgroundActivityPanel sessionId="session-1" />);
		expect(
			screen.queryByRole("button", { name: /BACKGROUND ACTIVITY/i }),
		).toBeNull();
	});

	it("shows live read-only provider activity without stop controls", () => {
		const restored = status();
		if (restored.background_activities?.[0]) {
			restored.background_activities[0] = {
				...restored.background_activities[0],
				kind: "shell",
				processId: undefined,
				capabilities: {},
			};
		}
		act(() => replaceSessionsStatus([restored]));
		render(<ProviderBackgroundActivityPanel sessionId="session-1" />);
		const toggle = screen.getByRole("button", {
			name: /BACKGROUND ACTIVITY/i,
		});
		if (toggle.getAttribute("aria-expanded") !== "true") {
			fireEvent.click(toggle);
		}

		expect(screen.getByText("RUNNING")).not.toBeNull();
		expect(screen.getByText("python3 -m http.server")).not.toBeNull();
		expect(
			screen.queryByRole("button", { name: "Stop background activity" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "STOP ALL" })).toBeNull();
	});
});
