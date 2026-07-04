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
import type { ProviderInfo } from "#/lib/serverFns";
import { AgentCard, type AgentEntry } from "./AgentCard";

afterEach(cleanup);

const claudeProvider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: true,
	models: [{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" }],
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
		hasClaudemd: false,
		dirExists: true,
		...overrides,
	};
}

function renderCard(agent: AgentEntry, providers: ProviderInfo[]) {
	return render(
		<AgentCard
			agent={agent}
			onRemove={vi.fn()}
			onModeChange={vi.fn()}
			onChat={vi.fn()}
			onSaveEdit={vi.fn().mockResolvedValue(undefined)}
			onReadClaudemd={vi.fn().mockResolvedValue(null)}
			providers={providers}
		/>,
	);
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
});
