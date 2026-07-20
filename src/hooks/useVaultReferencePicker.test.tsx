// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	searchRelicReferencesFn,
	searchVaultReferencesFn,
} from "#/lib/serverFns/vaultReferences";
import { useVaultReferencePicker } from "./useVaultReferencePicker";

vi.mock("#/lib/serverFns/vaultReferences", () => ({
	searchVaultReferencesFn: vi.fn(),
	searchRelicReferencesFn: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function useHarness(initialPrompt: string) {
	const [prompt, setPrompt] = useState(initialPrompt);
	return { prompt, picker: useVaultReferencePicker(prompt, setPrompt) };
}

describe("useVaultReferencePicker", () => {
	it("keeps Vault matches first and selects an existing Relic as context", async () => {
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
		await waitFor(() => expect(result.current.picker.items).toHaveLength(2));
		expect(result.current.picker.items.map((item) => item.source)).toEqual([
			"vault",
			"relic",
		]);

		act(() => result.current.picker.select(result.current.picker.items[1]));
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
});
