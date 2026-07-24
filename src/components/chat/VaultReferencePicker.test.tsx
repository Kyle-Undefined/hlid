// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceReferencePreview } from "#/lib/vaultReferences";
import { VaultReferencePicker } from "./VaultReferencePicker";

afterEach(cleanup);

type PickerProps = Parameters<typeof VaultReferencePicker>[0];

function renderPicker(
	workspacePreview: WorkspaceReferencePreview | null,
	overrides: Partial<PickerProps> = {},
) {
	return render(
		<VaultReferencePicker
			rootLabel="Fornbok"
			workspaceRootLabel="hlid"
			workspaceEnvironmentLabel="WSL · Ubuntu"
			query="pixel"
			items={[]}
			selectedIndex={0}
			loading={false}
			error={null}
			vaultTotal={0}
			relicTotal={0}
			workspaceTotal={1}
			workspaceAvailable
			activeSource="workspace"
			truncated={false}
			workspacePreview={workspacePreview}
			vaultPreview={null}
			relicPreview={null}
			previewLoading={false}
			previewError={null}
			workspaceSelectionLoading={null}
			onSelect={vi.fn()}
			onPreviewReference={vi.fn()}
			onSourceChange={vi.fn()}
			onConfirmReference={vi.fn()}
			onCancelReferencePreview={vi.fn()}
			{...overrides}
		/>,
	);
}

describe("VaultReferencePicker workspace previews", () => {
	it("renders a bounded raster preview with exact revision context", () => {
		renderPicker({
			relativePath: "screens/pixel.png",
			name: "pixel.png",
			directory: "screens",
			sizeBytes: 68,
			sha256: "a".repeat(64),
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			previewKind: "image",
			mime: "image/png",
			dataUrl: "data:image/png;base64,iVBORw0KGgo=",
			truncated: false,
		});

		expect(
			(
				screen.getByRole("img", {
					name: "Preview of screens/pixel.png",
				}) as HTMLImageElement
			).src,
		).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(screen.getByText("Exact image/png preview")).toBeTruthy();
		expect(screen.getByRole("button", { name: /add reference/i })).toBeTruthy();
	});

	it("renders exact Vault and existing Relic previews in the same pane", () => {
		const { rerender } = renderPicker(null, {
			vaultPreview: {
				relativePath: "Projects/Hlid.md",
				name: "Hlid.md",
				directory: "Projects",
				content: "# Hlid",
				truncated: false,
			},
		});
		expect(screen.getByText("# Hlid")).toBeTruthy();
		expect(screen.getByText("Exact Obsidian note preview")).toBeTruthy();

		rerender(
			<VaultReferencePicker
				rootLabel="Fornbok"
				workspaceRootLabel="hlid"
				workspaceEnvironmentLabel="WSL · Ubuntu"
				query="report"
				items={[]}
				selectedIndex={0}
				loading={false}
				error={null}
				vaultTotal={0}
				relicTotal={1}
				workspaceTotal={0}
				workspaceAvailable
				activeSource="relic"
				truncated={false}
				workspacePreview={null}
				vaultPreview={null}
				relicPreview={{
					id: "relic-1",
					path: "/relics/report.pdf",
					filename: "report.pdf",
					mime: "application/pdf",
					kind: "vault",
					createdAt: 1,
					category: "report",
				}}
				previewLoading={false}
				previewError={null}
				workspaceSelectionLoading={null}
				onSelect={vi.fn()}
				onPreviewReference={vi.fn()}
				onSourceChange={vi.fn()}
				onConfirmReference={vi.fn()}
				onCancelReferencePreview={vi.fn()}
			/>,
		);
		expect(screen.getByTitle("pdf preview").getAttribute("src")).toBe(
			"/api/attachments/relic-1/raw",
		);
		expect(screen.getByText("Existing Relic preview")).toBeTruthy();
	});

	it("attaches from every row and reserves every eye action for preview", () => {
		const onSelect = vi.fn();
		const onPreviewReference = vi.fn();
		const items: PickerProps["items"] = [
			{
				source: "vault",
				relativePath: "Projects/Hlid.md",
				name: "Hlid.md",
				directory: "Projects",
			},
			{
				source: "workspace",
				relativePath: "src/app.ts",
				name: "app.ts",
				directory: "src",
			},
			{
				source: "relic",
				id: "relic-1",
				path: "/relics/report.pdf",
				filename: "report.pdf",
				mime: "application/pdf",
				kind: "vault",
				createdAt: 1,
				category: "report",
			},
		];
		renderPicker(null, {
			query: "",
			items,
			onSelect,
			onPreviewReference,
		});

		const rows = screen.getAllByRole("option");
		for (const [index, row] of rows.entries()) {
			fireEvent.click(row);
			expect(onSelect).toHaveBeenLastCalledWith(items[index]);
		}
		expect(onPreviewReference).not.toHaveBeenCalled();

		const previewButtons = [
			screen.getByRole("button", {
				name: "Preview vault file Projects/Hlid.md",
			}),
			screen.getByRole("button", {
				name: "Preview workspace file src/app.ts",
			}),
			screen.getByRole("button", {
				name: "Preview Relic report.pdf",
			}),
		];
		for (const [index, button] of previewButtons.entries()) {
			fireEvent.click(button);
			expect(onPreviewReference).toHaveBeenLastCalledWith(items[index]);
		}
		expect(onSelect).toHaveBeenCalledTimes(3);
	});
});
