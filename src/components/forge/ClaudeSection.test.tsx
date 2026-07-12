// @vitest-environment jsdom
/**
 * Tests for per-model effort pickers in ClaudeSection: switching the model
 * should reset effort to whatever the newly selected model declares as its
 * own default (falling back to the first available option), and the
 * selected model's description should render as a hint under the picker.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import { type ClaudeForm, ClaudeSection } from "./ClaudeSection";

afterEach(cleanup);

const provider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: true,
	models: [
		{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
		{
			value: "claude-opus-4-1",
			label: "Opus 4.1",
			description: "the big one",
			efforts: [
				{ value: "low", label: "Low" },
				{ value: "high", label: "High", isDefault: true },
			],
		},
	],
	effortLevels: [{ value: "medium", label: "Medium" }],
	permissionModes: [{ value: "default", label: "Default" }],
};

function makeClaude(overrides: Partial<ClaudeForm> = {}): ClaudeForm {
	return {
		model: "claude-sonnet-4-6",
		effort: "medium",
		maxTurns: "",
		permissionMode: "default",
		turnRecaps: true,
		recapModel: "",
		vaultProvider: "claude",
		interactiveMode: false,
		...overrides,
	};
}

describe("ClaudeSection model/effort interplay", () => {
	it("resets effort to the new model's default effort on model change", () => {
		const onChange = vi.fn();
		render(
			<ClaudeSection
				claude={makeClaude()}
				onChange={onChange}
				providers={[provider]}
			/>,
		);

		// Selects render in order: Provider, Model, Recap model.
		const [, modelSelect] = screen.getAllByRole("combobox");
		fireEvent.change(modelSelect, { target: { value: "claude-opus-4-1" } });

		expect(onChange).toHaveBeenCalledWith({
			model: "claude-opus-4-1",
			effort: "high",
		});
	});

	it("resets effort when switching back to the provider-default model", () => {
		// Non-claude providers show a "— provider default —" ("") model option.
		const codexProvider: ProviderInfo = { ...provider, id: "codex" };
		const onChange = vi.fn();
		render(
			<ClaudeSection
				claude={makeClaude({
					vaultProvider: "codex",
					model: "claude-opus-4-1",
					effort: "high",
				})}
				onChange={onChange}
				providers={[codexProvider]}
			/>,
		);

		const [, modelSelect] = screen.getAllByRole("combobox");
		fireEvent.change(modelSelect, { target: { value: "" } });

		// "" falls back to provider-level effortLevels (medium), which doesn't
		// include "high" — so effort must be reset.
		expect(onChange).toHaveBeenCalledWith({ model: "", effort: "medium" });
	});

	it("shows the selected model's description as a hint", () => {
		render(
			<ClaudeSection
				claude={makeClaude({ model: "claude-opus-4-1", effort: "high" })}
				onChange={vi.fn()}
				providers={[provider]}
			/>,
		);

		expect(screen.getByText("the big one")).not.toBeNull();
	});

	it("marks the default model and effort options", () => {
		const withDefaults: ProviderInfo = {
			...provider,
			models: [
				{ ...provider.models?.[0], isDefault: true } as NonNullable<
					ProviderInfo["models"]
				>[number],
				...(provider.models?.slice(1) ?? []),
			],
		};
		render(
			<ClaudeSection
				claude={makeClaude({ model: "claude-opus-4-1", effort: "high" })}
				onChange={vi.fn()}
				providers={[withDefaults]}
			/>,
		);

		expect(screen.getByText("Sonnet 4.6 (default)")).not.toBeNull();
		expect(screen.getByText("High (default)")).not.toBeNull();
	});
});
