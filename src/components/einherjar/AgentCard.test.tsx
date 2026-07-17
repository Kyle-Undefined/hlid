// @vitest-environment jsdom
/**
 * Regression test for the provider options popup in the agent edit form.
 *
 * Bug: the model/effort/permission option lists were gated on
 * `editing.provider === vaultProvider`, so an agent whose provider differed
 * from the vault-level provider (e.g. vault_provider="codex", agent
 * provider="claude") showed no options at all. Options must instead reflect
 * whichever provider is currently selected in the edit form, independent of
 * any vault-level provider setting.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import { AgentCard, type AgentEntry } from "./AgentCard";

afterEach(cleanup);

const claudeProvider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: true,
	models: [
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{
			value: "claude-opus-4-1",
			label: "Opus 4.1",
			efforts: [
				{ value: "low", label: "Opus Low" },
				{ value: "high", label: "Opus High", isDefault: true },
			],
		},
	],
	effortLevels: [{ value: "high", label: "High" }],
	permissionModes: [{ value: "default", label: "Default" }],
};

const codexProvider: ProviderInfo = {
	id: "codex",
	label: "Codex",
	available: true,
	models: [{ value: "gpt-5-codex", label: "GPT-5 Codex" }],
	effortLevels: [{ value: "medium", label: "Medium" }],
	permissionModes: [{ value: "workspace-write", label: "Workspace Write" }],
};

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
	return {
		path: "/agents/foo",
		name: "Foo",
		mode: "cwd",
		provider: "claude",
		instructionFile: null,
		dirExists: true,
		...overrides,
	};
}

function renderCard(
	agent: AgentEntry,
	providers: ProviderInfo[],
	overrides: Partial<React.ComponentProps<typeof AgentCard>> = {},
) {
	const props: React.ComponentProps<typeof AgentCard> = {
		agent,
		onRemove: vi.fn(),
		onModeChange: vi.fn(),
		onChat: vi.fn(),
		onSaveEdit: vi.fn().mockResolvedValue(undefined),
		onReadInstructions: vi.fn().mockResolvedValue(null),
		providers,
		...overrides,
	};
	return render(<AgentCard {...props} />);
}

describe("AgentCard edit options", () => {
	it("shows the agent's own provider options even when a different provider is listed first", () => {
		// Simulates vault_provider="codex" with an agent whose provider is
		// "claude" — codex is passed first to mimic it being the vault default.
		renderCard(makeAgent({ provider: "claude" }), [
			codexProvider,
			claudeProvider,
		]);

		fireEvent.click(screen.getByTitle("Edit agent"));

		// Claude's own options must be present, not hidden and not codex's.
		// (model label appears twice — Model select + Recap model select.)
		expect(screen.getAllByText("Sonnet 4.6").length).toBeGreaterThan(0);
		expect(screen.getByText("High")).not.toBeNull();
		expect(screen.getByText("Default")).not.toBeNull();
		expect(screen.queryByText("GPT-5 Codex")).toBeNull();
	});

	it("shows the agent's own provider options when it is a codex agent under a claude vault", () => {
		renderCard(makeAgent({ provider: "codex" }), [
			claudeProvider,
			codexProvider,
		]);

		fireEvent.click(screen.getByTitle("Edit agent"));

		expect(screen.getAllByText("GPT-5 Codex").length).toBeGreaterThan(0);
		expect(screen.getByText("Medium")).not.toBeNull();
		expect(screen.getByText("Workspace Write")).not.toBeNull();
		expect(screen.queryByText("Sonnet 4.6")).toBeNull();
	});

	it("updates the option lists when the provider is switched mid-edit", () => {
		renderCard(makeAgent({ provider: "claude" }), [
			claudeProvider,
			codexProvider,
		]);

		fireEvent.click(screen.getByTitle("Edit agent"));
		expect(screen.getAllByText("Sonnet 4.6").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByText("Codex"));

		expect(screen.getAllByText("GPT-5 Codex").length).toBeGreaterThan(0);
		expect(screen.queryByText("Sonnet 4.6")).toBeNull();
	});

	it("updates the effort options when a model with its own efforts is selected", () => {
		renderCard(makeAgent({ provider: "claude" }), [claudeProvider]);

		fireEvent.click(screen.getByTitle("Edit agent"));

		// Model has no per-model efforts yet — falls back to provider-level list.
		expect(screen.getByText("High")).not.toBeNull();
		expect(screen.queryByText("Opus High (default)")).toBeNull();

		// Model select is the first <select> in the edit form.
		const [modelSelect] = screen.getAllByRole("combobox");
		fireEvent.change(modelSelect, {
			target: { value: "claude-opus-4-1" },
		});

		// Effort options now come from the selected model's own `efforts`.
		expect(screen.getByText("Opus Low")).not.toBeNull();
		expect(screen.getByText("Opus High (default)")).not.toBeNull();
		expect(screen.queryByText("High")).toBeNull();
	});

	it("keeps the editor open when saving fails", async () => {
		const onSaveEdit = vi.fn().mockRejectedValue(new Error("save failed"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		renderCard(makeAgent(), [claudeProvider], { onSaveEdit });

		fireEvent.click(screen.getByTitle("Edit agent"));
		fireEvent.change(screen.getByPlaceholderText("Display name"), {
			target: { value: "Renamed" },
		});
		fireEvent.click(screen.getByText("SAVE"));

		await screen.findByText("Edit Agent");
		expect(onSaveEdit).toHaveBeenCalledWith(
			"Renamed",
			"cwd",
			"claude",
			expect.any(Object),
		);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("cancels edits without persisting them", () => {
		const onSaveEdit = vi.fn().mockResolvedValue(undefined);
		renderCard(makeAgent(), [claudeProvider], { onSaveEdit });

		fireEvent.click(screen.getByTitle("Edit agent"));
		fireEvent.change(screen.getByPlaceholderText("Display name"), {
			target: { value: "Discard me" },
		});
		fireEvent.click(screen.getByText("CANCEL"));

		expect(screen.queryByText("Edit Agent")).toBeNull();
		expect(onSaveEdit).not.toHaveBeenCalled();
	});

	it("requires confirmation before removing the agent", () => {
		const onRemove = vi.fn();
		renderCard(makeAgent(), [claudeProvider], { onRemove });

		fireEvent.click(screen.getByText("×"));
		expect(onRemove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("confirm"));
		expect(onRemove).toHaveBeenCalledOnce();
	});

	it("keeps instruction expansion usable when loading fails", async () => {
		const onReadInstructions = vi
			.fn()
			.mockRejectedValue(new Error("read failed"));
		renderCard(makeAgent({ instructionFile: "AGENTS.md" }), [claudeProvider], {
			onReadInstructions,
		});

		fireEvent.click(screen.getByLabelText("Expand AGENTS.md"));
		await screen.findByLabelText("Collapse AGENTS.md");
		fireEvent.click(screen.getByLabelText("Collapse AGENTS.md"));
		fireEvent.click(screen.getByLabelText("Expand AGENTS.md"));

		expect(onReadInstructions).toHaveBeenCalledOnce();
	});

	it("delegates mode and chat actions without changing persisted props", () => {
		const onModeChange = vi.fn();
		const onChat = vi.fn();
		renderCard(makeAgent(), [claudeProvider], { onModeChange, onChat });

		expect(screen.getByTitle("Run in agent's directory")).not.toBeNull();
		expect(screen.queryByTitle(/Run claude/i)).toBeNull();
		fireEvent.click(screen.getByText("CTX"));
		fireEvent.click(screen.getByTitle("Chat with agent"));

		expect(onModeChange).toHaveBeenCalledWith("context");
		expect(onChat).toHaveBeenCalledOnce();
	});
});
