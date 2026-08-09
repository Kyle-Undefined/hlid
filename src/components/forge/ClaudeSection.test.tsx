// @vitest-environment jsdom
/**
 * Tests for per-model effort pickers in ClaudeSection: switching the model
 * should reset effort to whatever the newly selected model declares as its
 * own default (falling back to the first available option), and the
 * selected model's description should render as a hint under the picker.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import {
	type ClaudeForm,
	ClaudeSection,
	ComputerUseSection,
} from "./ClaudeSection";

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
		agentProgressSummaries: false,
		interactiveMode: false,
		peerInbox: false,
		...overrides,
	};
}

describe("Vault Agent and Computer Use model/effort interplay", () => {
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

	it("shows provider default when an ACP agent advertises no models", () => {
		const acpProvider: ProviderInfo = {
			id: "acp:pi-acp",
			label: "Pi ACP",
			available: true,
			models: [],
			permissionModes: [{ value: "default", label: "Agent asks" }],
		};
		render(
			<ClaudeSection
				claude={makeClaude({
					vaultProvider: "acp:pi-acp",
					model: "",
					effort: "",
				})}
				onChange={vi.fn()}
				providers={[acpProvider]}
			/>,
		);

		expect(
			screen.getAllByRole("option", { name: "— provider default —" }),
		).toHaveLength(2);
		expect(screen.getByText(/has not advertised model choices/i)).toBeTruthy();
		expect(screen.queryByText("Max turns")).toBeNull();
	});

	it("keeps a configured ACP model visible when the catalog is empty", () => {
		const acpProvider: ProviderInfo = {
			id: "acp:opencode",
			label: "OpenCode",
			available: true,
			models: [],
		};
		render(
			<ClaudeSection
				claude={makeClaude({
					vaultProvider: "acp:opencode",
					model: "anthropic/claude-sonnet-4-6",
				})}
				onChange={vi.fn()}
				providers={[acpProvider]}
			/>,
		);

		expect(
			screen.getByRole("option", {
				name: "anthropic/claude-sonnet-4-6 (configured)",
			}),
		).toBeTruthy();
		expect(
			screen.getByText(/still request the configured model/i),
		).toBeTruthy();
	});

	it("offers the default-off Claude peer inbox only for Claude", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<ClaudeSection
				claude={makeClaude()}
				onChange={onChange}
				providers={[provider]}
			/>,
		);

		const peerInbox = screen.getByRole("checkbox", {
			name: "Claude peer inbox",
		}) as HTMLInputElement;
		expect(peerInbox.checked).toBe(false);
		expect(
			screen.getByText(/sender claims are not human authority/i),
		).not.toBeNull();
		fireEvent.click(peerInbox);
		expect(onChange).toHaveBeenCalledWith({ peerInbox: true });

		rerender(
			<ClaudeSection
				claude={makeClaude({ vaultProvider: "codex" })}
				onChange={onChange}
				providers={[{ ...provider, id: "codex" }]}
			/>,
		);
		expect(
			screen.queryByRole("checkbox", { name: "Claude peer inbox" }),
		).toBeNull();
	});

	it("offers costed AI subagent progress summaries only for native Claude", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<ClaudeSection
				claude={makeClaude()}
				onChange={onChange}
				providers={[provider]}
			/>,
		);

		const summaries = screen.getByRole("checkbox", {
			name: "AI subagent progress summaries",
		}) as HTMLInputElement;
		expect(summaries.checked).toBe(false);
		expect(
			screen.getByText(
				"About every 30 seconds, Claude makes an extra model call for each running SDK subagent to write a short status. This adds token usage and may increase cost.",
			),
		).not.toBeNull();
		fireEvent.click(summaries);
		expect(onChange).toHaveBeenCalledWith({
			agentProgressSummaries: true,
		});

		rerender(
			<ClaudeSection
				claude={makeClaude({ vaultProvider: "codex" })}
				onChange={onChange}
				providers={[{ ...provider, id: "codex" }]}
			/>,
		);
		expect(
			screen.queryByRole("checkbox", {
				name: "AI subagent progress summaries",
			}),
		).toBeNull();
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

	it("shows one resolved provider capability snapshot without changing provider controls", () => {
		const withCapabilities: ProviderInfo = {
			...provider,
			capabilitySnapshot: {
				contractVersion: 1,
				providerId: "claude",
				status: "current",
				source: "live",
				revision: "v1-test",
				observedAt: 1,
				capabilities: [
					{
						id: "claude:sdk-control:rewindfiles",
						label: "SDK control: rewind files",
						scope: "session",
						support: "advertised",
						integration: "not-integrated",
						readiness: "ready",
						source: "provider-sdk",
						availability: "unavailable",
						reason: "Hlid does not integrate it yet.",
					},
				],
			},
		};
		render(
			<ClaudeSection
				claude={makeClaude()}
				onChange={vi.fn()}
				providers={[withCapabilities]}
			/>,
		);

		expect(screen.getByText("Capability snapshot")).not.toBeNull();
		expect(screen.getByText("1 observed")).not.toBeNull();
		expect(screen.getByText("1 not integrated")).not.toBeNull();
		fireEvent.click(screen.getByText("Inspect capability evidence"));
		expect(screen.getByText(/SDK control: rewind files/)).not.toBeNull();
	});

	it("keeps Windows Computer Use out of the Vault Agent section", () => {
		const codexProvider: ProviderInfo = {
			...provider,
			id: "codex",
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		};
		render(
			<ClaudeSection
				claude={makeClaude({ vaultProvider: "codex" })}
				onChange={vi.fn()}
				providers={[codexProvider]}
			/>,
		);

		expect(screen.queryByText("Windows Computer Use")).toBeNull();
	});

	it("shows Windows Computer Use host readiness for Codex", () => {
		const codexProvider: ProviderInfo = {
			...provider,
			id: "codex",
			label: "Codex",
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		};
		render(
			<ComputerUseSection
				claude={makeClaude({ vaultProvider: "codex" })}
				onChange={vi.fn()}
				providers={[codexProvider]}
			/>,
		);

		expect(screen.getByText("Windows Computer Use")).not.toBeNull();
		expect(screen.getByText("ready")).not.toBeNull();
		expect(
			screen.getByRole("img", { name: "Computer Use ready" }),
		).not.toBeNull();
		const modelSelect = screen.getByLabelText(
			"Computer Use model",
		) as HTMLSelectElement;
		expect(modelSelect.value).toBe("inherit");
		expect(modelSelect.className).toContain("w-full");
		expect(
			screen.getByText(
				"Use the model selected in the session that requested Computer Use.",
			).className,
		).toContain("max-w-none");
		const computerUseEffort = within(
			screen.getByRole("group", { name: "Computer Use effort" }),
		);
		expect(
			(
				computerUseEffort.getByRole("radio", {
					name: /Medium/,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			computerUseEffort.getByRole("radio", {
				name: /Inherit from calling session/,
			}),
		).not.toBeNull();
	});

	it("saves Windows Computer Use model and effort choices through the Codex form", () => {
		const onChange = vi.fn();
		const codexProvider: ProviderInfo = {
			...provider,
			id: "codex",
			label: "Codex",
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		};
		render(
			<ComputerUseSection
				claude={makeClaude({ vaultProvider: "codex" })}
				onChange={onChange}
				providers={[codexProvider]}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Computer Use model"), {
			target: { value: "claude-opus-4-1" },
		});
		fireEvent.click(
			screen.getByRole("radio", { name: /Inherit from calling session/ }),
		);

		expect(onChange).toHaveBeenCalledWith({
			windowsComputerUseModel: "claude-opus-4-1",
			windowsComputerUseEffort: "high",
		});
		expect(onChange).toHaveBeenCalledWith({
			windowsComputerUseEffort: "inherit",
		});
	});

	it("resets an unsupported Computer Use effort when its model changes", () => {
		const onChange = vi.fn();
		const codexProvider: ProviderInfo = {
			...provider,
			id: "codex",
			label: "Codex",
			models: [
				...(provider.models ?? []),
				{
					value: "fast-model",
					label: "Fast model",
					efforts: [{ value: "low", label: "Low", isDefault: true }],
				},
			],
			hostCapabilities: {
				windowsComputerUse: {
					label: "Windows Computer Use",
					available: true,
				},
			},
		};
		render(
			<ComputerUseSection
				claude={makeClaude({
					vaultProvider: "codex",
					windowsComputerUseModel: "claude-opus-4-1",
					windowsComputerUseEffort: "high",
				})}
				onChange={onChange}
				providers={[codexProvider]}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Computer Use model"), {
			target: { value: "fast-model" },
		});

		expect(onChange).toHaveBeenCalledWith({
			windowsComputerUseModel: "fast-model",
			windowsComputerUseEffort: "low",
		});
	});
});
