// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HlidTurnContextManifest } from "#/lib/hlidContext";

vi.mock("#/lib/serverFns/sessions", () => ({
	getSessionContextFn: vi.fn(),
}));

import { getSessionContextFn } from "#/lib/serverFns/sessions";
import { ContextInspectorDialog } from "./ContextInspectorDialog";

function contextManifest(
	overrides: Partial<HlidTurnContextManifest> = {},
): HlidTurnContextManifest {
	return {
		contractVersion: 1,
		recordedAt: Date.now(),
		delivery: "chat",
		providerId: "codex",
		model: "gpt-5.6-sol",
		userMessageChars: 20,
		promptChars: 120,
		providerPromptChars: 120,
		providerHandoffChars: 0,
		hlidAddedChars: 100,
		estimatedHlidTokens: 25,
		blocks: [],
		agentMode: "cwd",
		skills: [],
		attachments: [],
		vaultReferences: [],
		workspaceReferences: [],
		planHtml: false,
		toolLoading: [],
		...overrides,
	};
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ContextInspectorDialog", () => {
	it("shows pending selections and the last server-owned Hlid manifest", async () => {
		vi.mocked(getSessionContextFn).mockResolvedValue({
			context_window: 200_000,
			last_context_used: 12_000,
			actual_model: "gpt-5.6-sol",
			hlid_context: {
				contractVersion: 1,
				recordedAt: Date.now(),
				delivery: "chat",
				providerId: "codex",
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "default",
				userMessageChars: 20,
				promptChars: 4_020,
				providerPromptChars: 4_020,
				providerHandoffChars: 0,
				hlidAddedChars: 4_000,
				estimatedHlidTokens: 1_000,
				blocks: [
					{ kind: "vault", chars: 300, count: 1 },
					{ kind: "vault_references", chars: 3_700, count: 1 },
				],
				vaultName: "Fornbok",
				agentMode: "cwd",
				runtimeCwd: "/workspace",
				skills: [],
				attachments: [],
				vaultReferences: [
					{
						path: "Projects/Hlid.md",
						delivery: "inline-truncated",
						includedChars: 3_500,
						sourceChars: 8_000,
					},
				],
				workspaceReferences: [],
				planHtml: false,
				operatingBrief: {
					version: 1,
					briefRevision: "v1-a1b2c3d4",
					preview: "Hlid operating brief (v1):\n- Exact selections.",
					included: true,
					delivery: "included",
					chars: 520,
				},
				toolLoading: [
					{
						namespace: "hlid",
						total: 2,
						deferred: 1,
						tools: [
							{ name: "hlid_help", delivery: "deferred" },
							{ name: "windows_computer_use", delivery: "loaded" },
						],
					},
					{
						namespace: "hlid_obsidian",
						total: 28,
						deferred: 28,
						tools: [{ name: "read_note", delivery: "deferred" }],
					},
				],
			},
		});
		const onClose = vi.fn();

		render(
			<ContextInspectorDialog
				sessionId="session-1"
				pending={{
					providerId: "codex",
					model: "gpt-5.6-sol",
					effort: "high",
					permissionMode: "default",
					skills: ["/vault/skills/review.md"],
					attachments: [],
					vaultReferences: ["Projects/Hlid.md"],
					workspaceReferences: [],
					planMode: false,
				}}
				onClose={onClose}
			/>,
		);

		const dialog = screen.getByRole("dialog", { name: "Hlid context" });
		expect(dialog).toBeTruthy();
		expect(document.activeElement).toBe(dialog);
		expect(screen.getByText("1 note")).toBeTruthy();
		await waitFor(() => {
			expect(screen.getByText("Inlined, truncated · 3,500 chars")).toBeTruthy();
		});
		expect(screen.getByText("Vault operating context")).toBeTruthy();
		expect(screen.getByText("300 chars · 1 item")).toBeTruthy();
		expect(
			screen.getByText("Operating contract v1 · Brief v1-a1b2c3d4"),
		).toBeTruthy();
		expect(screen.getByText("Included · 520 chars")).toBeTruthy();
		expect(screen.getByText("28 of 28 deferred")).toBeTruthy();
		expect(screen.getByText("~1,000")).toBeTruthy();
		expect(screen.getByText(/Hlid operating brief \(v1\):/)).toBeTruthy();
		const hlidContext = screen
			.getAllByText("Hlid context")[1]
			.closest("details");
		expect(hlidContext?.open).toBe(false);

		const providerContext = screen
			.getByText("Provider context")
			.closest("details");
		expect(providerContext?.open).toBe(false);
		fireEvent.click(screen.getByText("Provider context"));
		expect(providerContext?.open).toBe(true);
		expect(screen.getByText("12,000 / 200,000 tokens")).toBeTruthy();
		expect(
			screen.getByText("Provider-owned and not exposed to Hlid"),
		).toBeTruthy();

		const hlidTools = screen.getByText("Hlid-owned tools").closest("details");
		expect(hlidTools?.open).toBe(false);
		fireEvent.click(screen.getByText("Hlid-owned tools"));
		expect(hlidTools?.open).toBe(true);

		const hlidNamespace = screen.getByText("hlid").closest("details");
		expect(hlidNamespace?.open).toBe(false);
		fireEvent.click(screen.getByText("hlid"));
		expect(hlidNamespace?.open).toBe(true);
		expect(
			within(hlidNamespace as HTMLElement).getByText("Loaded"),
		).toBeTruthy();
		expect(
			within(hlidNamespace as HTMLElement).getByText("Deferred"),
		).toBeTruthy();
		expect(
			within(hlidNamespace as HTMLElement).getByText("hlid_help"),
		).toBeTruthy();
		expect(
			within(hlidNamespace as HTMLElement).getByText("windows_computer_use"),
		).toBeTruthy();
		expect(screen.getByText("Provider-native tools")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Close Hlid context" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("honestly reports when no turn manifest exists yet", async () => {
		vi.mocked(getSessionContextFn).mockResolvedValue({
			context_window: null,
			last_context_used: null,
			actual_model: null,
			hlid_context: null,
		});
		render(
			<ContextInspectorDialog
				sessionId="new-session"
				pending={{
					skills: [],
					attachments: [],
					vaultReferences: [],
					workspaceReferences: [],
					planMode: false,
				}}
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByText(/No persisted Hlid context exists yet/),
			).toBeTruthy();
		});
	});

	it("shows an exact zero instead of an approximate zero token estimate", async () => {
		vi.mocked(getSessionContextFn).mockResolvedValue({
			context_window: null,
			last_context_used: null,
			actual_model: null,
			hlid_context: contextManifest({ estimatedHlidTokens: 0 }),
		});
		render(
			<ContextInspectorDialog
				sessionId="session-1"
				pending={{
					skills: [],
					attachments: [],
					vaultReferences: [],
					workspaceReferences: [],
					planMode: false,
				}}
				onClose={vi.fn()}
			/>,
		);

		const metric = (await screen.findByText("Rough tokens")).parentElement;
		expect(within(metric as HTMLElement).getByText("0")).toBeTruthy();
		expect(within(metric as HTMLElement).queryByText("~0")).toBeNull();
	});

	it("selects previous turn receipts and loads older pages without reusing current provider usage", async () => {
		const latest = contextManifest({
			recordedAt: new Date("2026-07-27T16:00:00Z").getTime(),
			model: "gpt-latest",
			hlidAddedChars: 100,
			estimatedHlidTokens: 25,
			blocks: [{ kind: "operating_brief", chars: 100, count: 1 }],
		});
		const previous = contextManifest({
			recordedAt: new Date("2026-07-27T15:00:00Z").getTime(),
			model: "gpt-previous",
			hlidAddedChars: 40,
			estimatedHlidTokens: 10,
			blocks: [{ kind: "skills", chars: 40, count: 1 }],
		});
		const older = contextManifest({
			recordedAt: new Date("2026-07-27T14:00:00Z").getTime(),
			model: "gpt-older",
			hlidAddedChars: 20,
			estimatedHlidTokens: 5,
		});
		vi.mocked(getSessionContextFn)
			.mockResolvedValueOnce({
				context_window: 200_000,
				last_context_used: 12_000,
				actual_model: "gpt-current",
				hlid_context: latest,
				hlid_contexts: [
					{
						seq: 10,
						timestamp: 1_722_096_000,
						turnNumber: 3,
						messagePreview: "Latest question",
						context: latest,
					},
					{
						seq: 6,
						timestamp: 1_722_092_400,
						turnNumber: 2,
						messagePreview: "Previous question",
						context: previous,
					},
				],
				has_more_contexts: true,
				next_context_before_seq: 6,
			})
			.mockResolvedValueOnce({
				context_window: 200_000,
				last_context_used: 12_000,
				actual_model: "gpt-current",
				hlid_context: older,
				hlid_contexts: [
					{
						seq: 2,
						timestamp: 1_722_088_800,
						turnNumber: 1,
						messagePreview: "First question",
						context: older,
					},
				],
				has_more_contexts: false,
				next_context_before_seq: 2,
			});

		render(
			<ContextInspectorDialog
				sessionId="session-1"
				pending={{
					skills: [],
					attachments: [],
					vaultReferences: [],
					workspaceReferences: [],
					planMode: false,
				}}
				onClose={vi.fn()}
			/>,
		);

		expect(
			(await screen.findAllByText("Latest question")).length,
		).toBeGreaterThan(0);
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.getByText("Turn 3")).toBeTruthy();
		expect(screen.getAllByText("100 chars").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "Older turn context" }));
		expect(screen.getAllByText("40 chars").length).toBeGreaterThan(0);

		const history = screen.getByText("Browse turns").closest("details");
		expect(history?.open).toBe(false);
		fireEvent.click(screen.getByText("Browse turns"));
		expect(history?.open).toBe(true);
		fireEvent.click(
			within(history as HTMLElement).getByRole("button", {
				name: /Turn 2.*Previous question/,
			}),
		);
		expect(screen.getAllByText("40 chars").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByText("Provider context"));
		expect(screen.getByText("Historical receipt")).toBeTruthy();
		expect(
			screen.getByText("Not retained for this historical turn"),
		).toBeTruthy();
		expect(screen.queryByText("12,000 / 200,000 tokens")).toBeNull();
		expect(screen.getAllByText("gpt-previous").length).toBeGreaterThan(0);
		expect(screen.queryByText("gpt-current")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));
		await waitFor(() => {
			expect(
				within(history as HTMLElement).getByRole("button", {
					name: /Turn 1.*First question/,
				}),
			).toBeTruthy();
		});
		expect(getSessionContextFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "session-1",
				beforeSeq: 6,
				limit: 20,
			},
		});
		expect(
			screen.queryByRole("button", { name: "Load older turns" }),
		).toBeNull();
	});

	it("opens directly on an older receipt selected from its transcript turn", async () => {
		const latest = contextManifest({
			recordedAt: new Date("2026-07-27T16:00:00Z").getTime(),
			hlidAddedChars: 100,
		});
		const target = contextManifest({
			recordedAt: new Date("2026-07-27T14:00:00Z").getTime(),
			hlidAddedChars: 20,
		});
		vi.mocked(getSessionContextFn)
			.mockResolvedValueOnce({
				context_window: 200_000,
				last_context_used: 12_000,
				actual_model: "gpt-current",
				hlid_context: latest,
				hlid_contexts: [
					{
						seq: 10,
						timestamp: 1_722_096_000,
						turnNumber: 3,
						messagePreview: "Latest question",
						context: latest,
					},
				],
				has_more_contexts: true,
				next_context_before_seq: 10,
			})
			.mockResolvedValueOnce({
				context_window: 200_000,
				last_context_used: 12_000,
				actual_model: "gpt-current",
				hlid_context: target,
				hlid_contexts: [
					{
						seq: 2,
						timestamp: 1_722_088_800,
						turnNumber: 1,
						turnId: "turn-1",
						messagePreview: "First question",
						context: target,
					},
				],
				has_more_contexts: false,
				next_context_before_seq: 2,
			});

		render(
			<ContextInspectorDialog
				sessionId="session-1"
				initialTarget={{ turnId: "turn-1" }}
				pending={{
					skills: [],
					attachments: [],
					vaultReferences: [],
					workspaceReferences: [],
					planMode: false,
				}}
				onClose={vi.fn()}
			/>,
		);

		expect(
			(await screen.findAllByText("First question")).length,
		).toBeGreaterThan(0);
		expect(screen.getAllByText("Turn 1").length).toBeGreaterThan(0);
		expect(
			(
				screen.getByRole("button", {
					name: "Older turn context",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Newer turn context",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(screen.getAllByText("20 chars").length).toBeGreaterThan(0);
		expect(getSessionContextFn).toHaveBeenNthCalledWith(2, {
			data: {
				sessionId: "session-1",
				beforeSeq: 10,
				limit: 20,
			},
		});
	});
});
