// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { RoutineDefinition } from "#/lib/routines";
import type { Skill } from "#/lib/skills";
import {
	RoutineManagerDialog,
	type RoutineTarget,
} from "./RoutineManagerDialog";

const serverFns = vi.hoisted(() => ({
	archiveRoutineFn: vi.fn(),
	createRoutineFn: vi.fn(),
	getRoutineRunsFn: vi.fn(),
	previewRoutineScheduleFn: vi.fn().mockResolvedValue([]),
	runRoutineNowFn: vi.fn(),
	setRoutineEnabledFn: vi.fn(),
	updateRoutineFn: vi.fn(),
}));
const vaultFns = vi.hoisted(() => ({
	searchVaultReferencesFn: vi.fn().mockResolvedValue({
		rootLabel: "Fornbok",
		items: [
			{
				relativePath: "Reports/Weekly.md",
				name: "Weekly.md",
				directory: "Reports",
			},
		],
		total: 1,
		truncated: false,
	}),
	searchRelicReferencesFn: vi.fn().mockResolvedValue({
		items: [
			{
				id: "11111111-1111-4111-8111-111111111111",
				path: "C:/Hlid/library/report.pdf",
				filename: "report.pdf",
				mime: "application/pdf",
				kind: "vault",
				createdAt: 1_753_185_600,
				category: "report",
			},
		],
		total: 1,
		truncated: false,
	}),
}));

vi.mock("#/lib/serverFns/routines", () => serverFns);
vi.mock("#/lib/serverFns/vaultReferences", () => vaultFns);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	serverFns.previewRoutineScheduleFn.mockResolvedValue([]);
});

const targets: RoutineTarget[] = [
	{
		path: "C:/Vault",
		name: "Fornbok",
		providerId: "codex",
		model: "gpt-5.4",
		effort: "medium",
	},
	{
		path: "C:/Projects/Hlid",
		name: "Hlid",
		providerId: "claude",
		model: "claude-opus-4-6",
		effort: "high",
	},
];

const providers: ProviderInfo[] = [
	{
		id: "codex",
		label: "Codex",
		available: true,
		models: [
			{
				value: "gpt-5.4",
				label: "GPT-5.4",
				isDefault: true,
				efforts: [{ value: "medium", label: "Medium", isDefault: true }],
			},
		],
	},
	{
		id: "claude",
		label: "Claude",
		available: true,
		models: [
			{
				value: "claude-opus-4-6",
				label: "Claude Opus 4.6",
				isDefault: true,
				efforts: [{ value: "high", label: "High", isDefault: true }],
			},
		],
	},
];

const skills: Skill[] = [
	{
		file: "review.md",
		filePath: "C:/Vault/Skills/review.md",
		name: "Vault Review",
		description: "Review work using the vault workflow",
		content: "Review carefully",
		source: "vault",
	},
	{
		file: "audit/SKILL.md",
		filePath: "C:/Hlid/skills/audit/SKILL.md",
		name: "AAA Hlid Audit",
		description: "Audit work using a Hlid-managed skill",
		content: "Audit carefully",
		source: "hlid",
	},
	{
		file: "research/SKILL.md",
		filePath: "C:/Users/kyle/.claude/skills/research/SKILL.md",
		name: "Claude Research",
		description: "Use Claude's native research workflow",
		content: "Research carefully",
		providerId: "claude",
		source: "provider",
	},
];

const defaultDefinition: RoutineDefinition = {
	name: "New Routine",
	prompt: "",
	enabled: false,
	schedule: { kind: "daily", time: "09:00" },
	timezone: "America/New_York",
	providerId: "codex",
	model: "gpt-5.4",
	effort: "medium",
	agentCwd: "C:/Vault",
	agentName: "Fornbok",
	skillContexts: [],
	providerCommands: [],
	vaultReferences: [],
	relicIds: [],
	permissionMode: "read_only",
	grants: [],
	deliveries: [],
	catchUpWindowMinutes: 360,
	noOverlap: true,
};

describe("RoutineManagerDialog", () => {
	it("returns from the editor to the Routines overview before closing", () => {
		const onClose = vi.fn();
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={onClose}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "New Routine" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Close Routines" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("opens the overview before creating from Watch", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={null}
				watchDefinition={{
					...defaultDefinition,
					prompt: "Seeded from Watch",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(screen.getByRole("button", { name: "New Routine" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "New from Watch" }));
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
			"Seeded from Watch",
		);
	});

	it("creates an independent Routine and applies workspace harness defaults", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /New Routine/i }));
		const workspace = screen.getByLabelText("Workspace");
		const harness = screen.getByLabelText("Harness");
		const model = screen.getByLabelText("Model");
		const effort = screen.getByLabelText("Effort");

		expect((workspace as HTMLSelectElement).value).toBe("C:/Vault");
		expect((harness as HTMLSelectElement).value).toBe("codex");
		expect((model as HTMLSelectElement).value).toBe("gpt-5.4");
		expect((effort as HTMLSelectElement).value).toBe("medium");

		fireEvent.change(workspace, { target: { value: "C:/Projects/Hlid" } });
		expect((harness as HTMLSelectElement).value).toBe("claude");
		expect((model as HTMLSelectElement).value).toBe("claude-opus-4-6");
		expect((effort as HTMLSelectElement).value).toBe("high");
	});

	it("keeps model and effort editable when provider discovery is unavailable", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={[]}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const model = screen.getByLabelText("Model");
		const effort = screen.getByLabelText("Effort");
		expect(model.tagName).toBe("INPUT");
		expect(effort.tagName).toBe("INPUT");
		fireEvent.change(model, { target: { value: "custom-model" } });
		fireEvent.change(effort, { target: { value: "custom-effort" } });
		expect((model as HTMLInputElement).value).toBe("custom-model");
		expect((effort as HTMLInputElement).value).toBe("custom-effort");
	});

	it("selects an exact delivery note from the vault", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					prompt: "Write the weekly report",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Exact vault note"));
		fireEvent.click(screen.getByRole("button", { name: "Choose note" }));
		expect(await screen.findByLabelText("Search vault notes")).toBeDefined();
		await waitFor(() =>
			expect(vaultFns.searchVaultReferencesFn).toHaveBeenCalledWith({
				data: { query: "", limit: 40, notesOnly: true },
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Select Reports/Weekly.md",
			}),
		);
		expect(screen.getByTitle("Reports/Weekly.md").textContent).toContain(
			"Reports/Weekly.md",
		);

		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));
		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					deliveries: [{ kind: "note_append", path: "Reports/Weekly.md" }],
				}),
			}),
		);
	});

	it("selects durable context and provider-native skills", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByLabelText(/Vault Review/));
		fireEvent.change(screen.getByLabelText("Workspace"), {
			target: { value: "C:/Projects/Hlid" },
		});
		fireEvent.click(screen.getByLabelText(/Claude Research/));
		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));

		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					skillContexts: ["C:/Vault/Skills/review.md"],
					providerCommands: ["Claude Research"],
				}),
			}),
		);
	});

	it("orders skills as Vault, Hlid, then the selected provider", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					providerId: "claude",
					model: "claude-opus-4-6",
					effort: "high",
					agentCwd: "C:/Projects/Hlid",
					agentName: "Hlid",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const vault = screen.getByText("Vault Review");
		const hlid = screen.getByText("AAA Hlid Audit");
		const provider = screen.getByText("Claude Research");
		expect(
			vault.compareDocumentPosition(hlid) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			hlid.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("selects exact vault and retained Relic inputs", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{ ...defaultDefinition, prompt: "Compare inputs" }}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add inputs" }));
		expect(await screen.findByLabelText("Search Routine inputs")).toBeDefined();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Add vault input Reports/Weekly.md",
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Add Relic input report.pdf",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));

		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					vaultReferences: ["Reports/Weekly.md"],
					relicIds: ["11111111-1111-4111-8111-111111111111"],
				}),
			}),
		);
	});
});
