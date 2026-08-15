// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	previewVaultReferenceFn,
	previewWorkspaceReferenceFn,
	searchRelicReferencesFn,
	searchVaultReferencesFn,
	searchWorkspaceReferencesFn,
	selectWorkspaceReferenceFn,
} from "#/lib/serverFns/vaultReferences";
import { useVaultReferencePicker } from "./useVaultReferencePicker";

vi.mock("#/lib/serverFns/vaultReferences", () => ({
	searchVaultReferencesFn: vi.fn(),
	searchRelicReferencesFn: vi.fn(),
	searchWorkspaceReferencesFn: vi.fn(),
	previewVaultReferenceFn: vi.fn(),
	previewWorkspaceReferenceFn: vi.fn(),
	selectWorkspaceReferenceFn: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function useHarness(initialPrompt: string, workspaceAgentCwd?: string) {
	const [prompt, setPrompt] = useState(initialPrompt);
	return {
		prompt,
		setPrompt,
		picker: useVaultReferencePicker(prompt, setPrompt, { workspaceAgentCwd }),
	};
}

describe("useVaultReferencePicker", () => {
	it("keeps Vault and Relic eye previews separate from row attachment", async () => {
		vi.mocked(searchVaultReferencesFn).mockResolvedValue({
			rootLabel: "Fornbok",
			items: [
				{
					relativePath: "Projects/Hlid.md",
					name: "Hlid.md",
					directory: "Projects",
				},
			],
			total: 1,
			truncated: false,
		});
		vi.mocked(searchRelicReferencesFn).mockResolvedValue({
			items: [
				{
					id: "relic-1",
					path: "/vault/.hlid/report.pdf",
					filename: "report.pdf",
					mime: "application/pdf",
					kind: "vault",
					createdAt: 123,
					category: "report",
				},
			],
			total: 1,
			truncated: false,
		});
		vi.mocked(previewVaultReferenceFn).mockResolvedValue({
			relativePath: "Projects/Hlid.md",
			name: "Hlid.md",
			directory: "Projects",
			content: "# Hlid",
			truncated: false,
		});

		const { result } = renderHook(() => useHarness("Review @hlid"));
		await waitFor(() =>
			expect(result.current.picker.items[0]?.source).toBe("vault"),
		);
		const vault = result.current.picker.items[0];
		if (!vault) throw new Error("missing Vault result");
		act(() => result.current.picker.previewReference(vault));
		await waitFor(() =>
			expect(result.current.picker.vaultPreview?.content).toBe("# Hlid"),
		);
		expect(result.current.picker.selected).toEqual([]);
		expect(result.current.prompt).toBe("Review @hlid");

		act(() => result.current.picker.cancelReferencePreview());
		act(() => result.current.picker.setActiveSource("relic"));
		await waitFor(() =>
			expect(result.current.picker.items[0]?.source).toBe("relic"),
		);
		const relic = result.current.picker.items[0];
		if (!relic) throw new Error("missing Relic result");
		act(() => result.current.picker.previewReference(relic));
		expect(result.current.picker.relicPreview?.filename).toBe("report.pdf");
		expect(result.current.picker.selectedRelics).toEqual([]);

		act(() => result.current.picker.confirmReferencePreview());
		expect(result.current.prompt).toBe("Review ");
		expect(result.current.picker.selectedRelics).toEqual([
			expect.objectContaining({ id: "relic-1" }),
		]);
	});

	it("switches source tabs and selects an existing Relic as context", async () => {
		vi.mocked(searchVaultReferencesFn).mockResolvedValue({
			rootLabel: "Fornbok",
			items: [
				{
					relativePath: "Projects/Hlid.md",
					name: "Hlid.md",
					directory: "Projects",
				},
			],
			total: 1,
			truncated: false,
		});
		vi.mocked(searchRelicReferencesFn).mockResolvedValue({
			items: [
				{
					id: "relic-1",
					path: "/vault/.hlid/report.pdf",
					filename: "report.pdf",
					mime: "application/pdf",
					kind: "vault",
					createdAt: 123,
					category: "report",
				},
			],
			total: 1,
			truncated: false,
		});

		const { result } = renderHook(() => useHarness("Compare @report"));
		await waitFor(() => expect(result.current.picker.items).toHaveLength(1));
		expect(result.current.picker.items[0]?.source).toBe("vault");

		act(() => result.current.picker.setActiveSource("relic"));
		await waitFor(() =>
			expect(result.current.picker.items[0]?.source).toBe("relic"),
		);
		const relic = result.current.picker.items[0];
		expect(relic?.source).toBe("relic");
		if (!relic) throw new Error("missing Relic result");
		act(() => result.current.picker.select(relic));
		expect(result.current.prompt).toBe("Compare ");
		expect(result.current.picker.selectedRelics).toHaveLength(1);
		expect(result.current.picker.relicAttachments).toEqual([
			expect.objectContaining({
				id: "relic-1",
				filename: "report.pdf",
				reference: "relic",
			}),
		]);
	});

	it("selects an exact workspace revision directly while keeping preview explicit", async () => {
		vi.mocked(searchVaultReferencesFn).mockResolvedValue({
			rootLabel: "Fornbok",
			items: [],
			total: 0,
			truncated: false,
		});
		vi.mocked(searchRelicReferencesFn).mockResolvedValue({
			items: [],
			total: 0,
			truncated: false,
		});
		vi.mocked(searchWorkspaceReferencesFn).mockResolvedValue({
			rootLabel: "hlid",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			items: [
				{
					relativePath: "src/server/session.ts",
					name: "session.ts",
					directory: "src/server",
				},
			],
			total: 1,
			truncated: false,
		});
		vi.mocked(previewWorkspaceReferenceFn).mockResolvedValue({
			relativePath: "src/server/session.ts",
			name: "session.ts",
			directory: "src/server",
			content: "export class Session {}",
			sizeBytes: 23,
			truncated: false,
			sha256: "a".repeat(64),
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			previewKind: "text",
			mime: "text/plain",
		});
		vi.mocked(selectWorkspaceReferenceFn).mockResolvedValue({
			relativePath: "src/server/session.ts",
			name: "session.ts",
			directory: "src/server",
			sizeBytes: 23,
			sha256: "a".repeat(64),
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			previewKind: "text",
			mime: "text/plain",
		});

		const { result } = renderHook(() =>
			useHarness("Review @session", "/work/hlid"),
		);
		act(() => result.current.picker.setActiveSource("workspace"));
		await waitFor(() =>
			expect(result.current.picker.items[0]?.source).toBe("workspace"),
		);
		const workspace = result.current.picker.items[0];
		if (!workspace) throw new Error("missing workspace result");
		act(() => result.current.picker.previewReference(workspace));
		await waitFor(() =>
			expect(result.current.picker.workspacePreview?.relativePath).toBe(
				"src/server/session.ts",
			),
		);
		expect(result.current.picker.selectedWorkspace).toEqual([]);
		expect(result.current.prompt).toBe("Review @session");

		act(() => result.current.picker.cancelReferencePreview());
		act(() => result.current.picker.select(workspace));
		await waitFor(() => {
			expect(result.current.prompt).toBe("Review ");
			expect(result.current.picker.workspaceReferences).toEqual([
				{
					relativePath: "src/server/session.ts",
					sha256: "a".repeat(64),
				},
			]);
		});
		expect(result.current.picker.workspacePreview).toBeNull();
	});

	it("keeps Vault search usable when the workspace is offline", async () => {
		vi.mocked(searchVaultReferencesFn).mockResolvedValue({
			rootLabel: "Fornbok",
			items: [
				{
					relativePath: "Projects/Hlid.md",
					name: "Hlid.md",
					directory: "Projects",
				},
			],
			total: 1,
			truncated: false,
		});
		vi.mocked(searchRelicReferencesFn).mockResolvedValue({
			items: [],
			total: 0,
			truncated: false,
		});
		vi.mocked(searchWorkspaceReferencesFn).mockRejectedValue(
			new Error("WSL is offline"),
		);

		const { result } = renderHook(() =>
			useHarness("Review @hlid", "/work/hlid"),
		);
		await waitFor(() =>
			expect(result.current.picker.items[0]).toMatchObject({
				source: "vault",
				relativePath: "Projects/Hlid.md",
			}),
		);
		expect(result.current.picker.error).toBeNull();

		act(() => result.current.picker.setActiveSource("workspace"));
		await waitFor(() =>
			expect(result.current.picker.error).toBe("WSL is offline"),
		);
	});

	it("accumulates multiple directly selected workspace files", async () => {
		vi.mocked(searchVaultReferencesFn).mockResolvedValue({
			rootLabel: "Fornbok",
			items: [],
			total: 0,
			truncated: false,
		});
		vi.mocked(searchRelicReferencesFn).mockResolvedValue({
			items: [],
			total: 0,
			truncated: false,
		});
		vi.mocked(searchWorkspaceReferencesFn).mockImplementation(async () => ({
			rootLabel: "hlid",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			items: [
				{ relativePath: "first.ts", name: "first.ts", directory: "" },
				{ relativePath: "second.ts", name: "second.ts", directory: "" },
			],
			total: 2,
			truncated: false,
		}));
		vi.mocked(selectWorkspaceReferenceFn).mockImplementation(
			async (options) => {
				const { data } = options as {
					data: { agentCwd: string; relativePath: string };
				};
				return {
					relativePath: data.relativePath,
					name: data.relativePath,
					directory: "",
					sizeBytes: data.relativePath.length,
					sha256: data.relativePath.startsWith("first")
						? "a".repeat(64)
						: "b".repeat(64),
					environment: "wsl",
					environmentLabel: "WSL · Ubuntu",
					previewKind: "text",
					mime: "text/plain",
				};
			},
		);

		const { result } = renderHook(() =>
			useHarness("Review @first", "/work/hlid"),
		);
		act(() => result.current.picker.setActiveSource("workspace"));
		await waitFor(() =>
			expect(result.current.picker.items[0]).toMatchObject({
				source: "workspace",
				relativePath: "first.ts",
			}),
		);
		const first = result.current.picker.items[0];
		if (!first) throw new Error("missing first workspace result");
		act(() => result.current.picker.select(first));
		await waitFor(() =>
			expect(result.current.picker.workspaceReferences).toEqual([
				{ relativePath: "first.ts", sha256: "a".repeat(64) },
			]),
		);

		act(() => result.current.setPrompt("Review @second"));
		await waitFor(() =>
			expect(result.current.picker.items[0]).toMatchObject({
				source: "workspace",
				relativePath: "second.ts",
			}),
		);
		const second = result.current.picker.items[0];
		if (!second) throw new Error("missing second workspace result");
		act(() => result.current.picker.select(second));
		await waitFor(() =>
			expect(result.current.picker.workspaceReferences).toEqual([
				{ relativePath: "first.ts", sha256: "a".repeat(64) },
				{ relativePath: "second.ts", sha256: "b".repeat(64) },
			]),
		);
	});

	it("replaces restored Vault, Relic, and workspace selections exactly", () => {
		const { result } = renderHook(() => useHarness("", "/work/hlid"));
		act(() =>
			result.current.picker.replaceSelections({
				vault: [
					{
						relativePath: "Projects/Hlid.md",
						name: "Hlid.md",
						directory: "Projects",
					},
				],
				relics: [
					{
						id: "relic-1",
						path: "/vault/.hlid/report.pdf",
						filename: "report.pdf",
						mime: "application/pdf",
						kind: "vault",
						createdAt: 123,
						category: "report",
					},
				],
				workspace: [
					{
						relativePath: "src/server/session.ts",
						name: "session.ts",
						directory: "src/server",
						sizeBytes: 23,
						sha256: "a".repeat(64),
						environment: "wsl",
						environmentLabel: "WSL · Ubuntu",
						previewKind: "text",
						mime: "text/plain",
					},
				],
			}),
		);

		act(() =>
			result.current.picker.replaceSelections({
				vault: [
					{
						relativePath: "Inbox/Todo.md",
						name: "Todo.md",
						directory: "Inbox",
					},
				],
				relics: [],
				workspace: [],
			}),
		);

		expect(result.current.picker.selected).toEqual([
			{
				relativePath: "Inbox/Todo.md",
				name: "Todo.md",
				directory: "Inbox",
			},
		]);
		expect(result.current.picker.selectedRelics).toEqual([]);
		expect(result.current.picker.selectedWorkspace).toEqual([]);
	});
});
