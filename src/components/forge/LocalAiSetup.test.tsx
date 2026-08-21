// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAiSetupSnapshot } from "#/lib/localAiSetup";
import {
	getLocalAiSetupFn,
	mutateLocalAiSetupFn,
} from "#/lib/serverFns/localAiSetup";
import { LocalAiSetup } from "./LocalAiSetup";

vi.mock("#/lib/serverFns/localAiSetup", () => ({
	getLocalAiSetupFn: vi.fn(),
	mutateLocalAiSetupFn: vi.fn(),
}));

const snapshot = {
	intent: { version: 1, startedAt: 1, updatedAt: 1, acknowledged: [] },
	live: {
		ollama: { supported: true, available: false, setupPhase: "idle" },
		openCode: { configured: false, available: false, target: null },
		models: { selected: [], present: [] },
		wslAccessRequired: false,
		firewallReady: null,
	},
	steps: [
		{
			id: "ollama" as const,
			title: "Windows Ollama",
			description: "Install it in its existing flow.",
			status: "needs-action" as const,
			acknowledged: false,
			action: "ollama" as const,
		},
	],
} satisfies LocalAiSetupSnapshot;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getLocalAiSetupFn).mockResolvedValue(snapshot);
	vi.mocked(mutateLocalAiSetupFn).mockResolvedValue(snapshot);
});

describe("LocalAiSetup", () => {
	it("rechecks state and routes mutation work to the existing owner", async () => {
		const onOpenOllama = vi.fn();
		render(
			<LocalAiSetup onOpenOllama={onOpenOllama} onOpenOpenCode={vi.fn()} />,
		);

		await screen.findByText("Windows Ollama");
		fireEvent.click(screen.getByRole("button", { name: "Open Ollama" }));
		expect(onOpenOllama).toHaveBeenCalledOnce();
		expect(mutateLocalAiSetupFn).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
		await waitFor(() =>
			expect(mutateLocalAiSetupFn).toHaveBeenCalledWith({
				data: { action: "acknowledge", step: "ollama" },
			}),
		);
	});
});
