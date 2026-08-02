// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	InstructionFileDocument,
	InstructionFileTarget,
} from "#/lib/instructionFileTypes";
import { InstructionFilesPanel } from "./InstructionFilesPanel";

vi.mock("#/lib/serverFns/instructionFiles", () => ({
	readInstructionFileFn: vi.fn(),
	writeInstructionFileFn: vi.fn(),
}));

const { readInstructionFileFn, writeInstructionFileFn } = await import(
	"#/lib/serverFns/instructionFiles"
);
const mockRead = vi.mocked(readInstructionFileFn);
const mockWrite = vi.mocked(writeInstructionFileFn);

function target(
	overrides: Partial<InstructionFileTarget> = {},
): InstructionFileTarget {
	return {
		id: "instructions:vault-codex",
		owner: "vault",
		provider: "codex",
		filename: "AGENTS.md",
		scopeLabel: "Fornbok",
		environment: "windows",
		environmentLabel: "Windows",
		path: "C:\\Vault\\AGENTS.md",
		exists: true,
		size: 12,
		revision: "a".repeat(64),
		writable: true,
		...overrides,
	};
}

function document(
	targetValue: InstructionFileTarget,
	content = "# Existing",
): InstructionFileDocument {
	return { ...targetValue, exists: targetValue.exists ?? true, content };
}

beforeEach(() => {
	vi.resetAllMocks();
});

afterEach(cleanup);

describe("InstructionFilesPanel", () => {
	it("keeps exact byte and KiB size labels", () => {
		render(
			<InstructionFilesPanel
				targets={[
					target({ id: "bytes", filename: "AGENTS.md", size: 1023 }),
					target({ id: "small-kib", filename: "CLAUDE.md", size: 1536 }),
					target({
						id: "rounded-kib",
						filename: "AGENTS.md",
						size: 10 * 1024,
					}),
					target({
						id: "missing",
						filename: "CLAUDE.md",
						exists: false,
						size: null,
						revision: null,
					}),
				]}
			/>,
		);

		expect(screen.getByText("1023 B")).toBeTruthy();
		expect(screen.getByText("1.5 KiB")).toBeTruthy();
		expect(screen.getByText("10 KiB")).toBeTruthy();
		expect(screen.getByText("missing")).toBeTruthy();
	});

	it("opens an uninspected configured target before labeling it create or edit", async () => {
		const uninspected = target({
			exists: null,
			size: null,
			revision: null,
		});
		mockRead.mockResolvedValue(document(target()));
		render(<InstructionFilesPanel targets={[uninspected]} />);

		expect(screen.getByText("not checked")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(await screen.findByText("Existing")).not.toBeNull();
	});

	it("previews and explicitly saves an existing file", async () => {
		const current = target();
		mockRead.mockResolvedValue(document(current));
		mockWrite.mockImplementation(async (options) => {
			const data = (
				options as {
					data: {
						id: string;
						content: string;
						expectedRevision: string | null;
					};
				}
			).data;
			return {
				...document(current, data.content),
				revision: "b".repeat(64),
				size: data.content.length,
			};
		});
		render(<InstructionFilesPanel targets={[current]} />);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Expand AGENTS.md · Fornbok · Windows",
			}),
		);
		expect(await screen.findByText("Existing")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(
			screen.getByRole("textbox", {
				name: "Edit AGENTS.md · Fornbok · Windows",
			}),
			{ target: { value: "# Updated" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mockWrite).toHaveBeenCalledWith({
				data: {
					id: current.id,
					content: "# Updated",
					expectedRevision: "a".repeat(64),
				},
			}),
		);
		expect(
			await screen.findByText(
				"Saved. Reload active provider sessions to use the change.",
			),
		).not.toBeNull();
	});

	it("opens a missing file directly in create mode", async () => {
		const missing = target({
			id: "instructions:vault-claude",
			provider: "claude",
			filename: "CLAUDE.md",
			path: "C:\\Vault\\CLAUDE.md",
			exists: false,
			size: null,
			revision: null,
		});
		mockRead.mockResolvedValue(document(missing, ""));
		render(<InstructionFilesPanel targets={[missing]} />);

		fireEvent.click(screen.getByRole("button", { name: "Create" }));

		expect(
			await screen.findByRole("textbox", {
				name: "Edit CLAUDE.md · Fornbok · Windows",
			}),
		).not.toBeNull();
	});
});
