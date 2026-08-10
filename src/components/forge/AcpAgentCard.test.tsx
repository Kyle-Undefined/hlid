// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AcpAgentInfo,
	AcpAuthMethod,
	AcpCatalogItem,
} from "#/lib/serverFns/acp";
import {
	AcpAgentCard,
	type AcpAgentConfig,
	type AcpModelOption,
} from "./AcpAgentCard";

afterEach(cleanup);

function makeItem(overrides?: Partial<AcpCatalogItem>): AcpCatalogItem {
	return {
		id: "gemini",
		name: "Gemini CLI",
		version: "1.2.0",
		description: "Google's ACP agent",
		available: true,
		command: "gemini",
		args: ["--acp"],
		installGuidance: "npm i -g @google/gemini-cli",
		...overrides,
	} as AcpCatalogItem;
}

function renderCard(
	overrides?: Partial<{
		item: AcpCatalogItem;
		configured: AcpAgentConfig | undefined;
		operation: "inspect" | "refresh" | null;
		disabled: boolean;
		authMethods: AcpAuthMethod[] | undefined;
		agentInfo: AcpAgentInfo | null | undefined;
		models: AcpModelOption[] | undefined;
		optionsRefreshed: boolean;
		configurationCurrent: boolean;
		onToggle: () => void;
		onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
		onInspect: (methodId?: string) => void;
		onRefreshOptions: () => void;
		onDiscoverModels:
			| (() => Promise<Array<{ value: string; label: string }> | undefined>)
			| undefined;
	}>,
) {
	const props = {
		item: makeItem(),
		configured: undefined,
		operation: null,
		disabled: false,
		authMethods: undefined,
		agentInfo: undefined,
		models: undefined,
		optionsRefreshed: false,
		configurationCurrent: true,
		onToggle: vi.fn(),
		onUpdateOverride: vi.fn(),
		onInspect: vi.fn(),
		onRefreshOptions: vi.fn(),
		onDiscoverModels: undefined,
		...overrides,
	};
	const rendered = render(<AcpAgentCard {...props} />);
	return {
		...props,
		rerenderCard: (next: Partial<typeof props>): void =>
			rendered.rerender(<AcpAgentCard {...props} {...next} />),
	};
}

describe("AcpAgentCard", () => {
	it("shows Enable and command line when unconfigured but available", () => {
		const { onToggle } = renderCard();
		expect(screen.getByText("gemini --acp · path found")).toBeTruthy();
		expect(screen.getByText("catalog 1.2.0")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Enable" }));
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("shows install guidance when unavailable", () => {
		renderCard({ item: makeItem({ available: false }) });
		expect(screen.getByText("npm i -g @google/gemini-cli")).toBeTruthy();
	});

	it("shows overrides and auth entry point when configured", () => {
		const { onInspect, onRefreshOptions } = renderCard({
			configured: { id: "gemini" } as AcpAgentConfig,
		});
		expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
		expect(screen.getByText("Executable override")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Inspect agent" }));
		expect(onInspect).toHaveBeenCalledWith();
		fireEvent.click(screen.getByRole("button", { name: "Refresh options" }));
		expect(onRefreshOptions).toHaveBeenCalledOnce();
	});

	it("waits for persisted runtime configuration before allowing live actions", () => {
		const { onInspect, onRefreshOptions } = renderCard({
			configured: { id: "gemini", executable: "/new/gemini" } as AcpAgentConfig,
			configurationCurrent: false,
		});
		const waiting = screen.getAllByRole("button", {
			name: "Waiting for saved configuration…",
		});

		expect(waiting).toHaveLength(2);
		for (const button of waiting) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(button);
		}
		expect(onInspect).not.toHaveBeenCalled();
		expect(onRefreshOptions).not.toHaveBeenCalled();
	});

	it("keeps staged OpenCode filters editable while live discovery waits for save", () => {
		const discover = vi.fn().mockResolvedValue([]);
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			configurationCurrent: false,
			onDiscoverModels: discover,
		});

		const refresh = screen.getByRole("button", {
			name: "Refresh full model list",
		}) as HTMLButtonElement;
		const onlySelected = screen.getByRole("radio", {
			name: /Only selected/i,
		}) as HTMLInputElement;
		expect(refresh.disabled).toBe(true);
		expect(onlySelected.disabled).toBe(false);
		fireEvent.click(onlySelected);
		expect(onlySelected.checked).toBe(true);
		fireEvent.click(refresh);
		expect(discover).not.toHaveBeenCalled();
	});

	it("shows the negotiated installed agent identity after inspection", () => {
		renderCard({
			configured: { id: "gemini" } as AcpAgentConfig,
			agentInfo: { name: "Gemini CLI", version: "1.1.7" },
		});
		expect(screen.getByText("initialized Gemini CLI 1.1.7")).toBeTruthy();
	});

	it("propagates executable and args overrides, clearing empty values", () => {
		const { onUpdateOverride } = renderCard({
			configured: {
				id: "gemini",
				executable: "/usr/bin/gemini",
				args: ["--acp", "--debug"],
			} as AcpAgentConfig,
		});
		const [exe, args] = screen.getAllByRole("textbox") as HTMLInputElement[];
		expect(exe.value).toBe("/usr/bin/gemini");
		expect(args.value).toBe("--acp --debug");
		fireEvent.change(exe, { target: { value: "" } });
		expect(onUpdateOverride).toHaveBeenCalledWith({ executable: undefined });
		fireEvent.change(args, { target: { value: "  --flag one  " } });
		expect(onUpdateOverride).toHaveBeenCalledWith({
			args: ["--flag", "one"],
		});
		fireEvent.change(args, { target: { value: "   " } });
		expect(onUpdateOverride).toHaveBeenCalledWith({ args: undefined });
	});

	it("presents advertised auth methods as optional credential management", () => {
		const { onInspect } = renderCard({
			configured: { id: "gemini" } as AcpAgentConfig,
			operation: "inspect",
			authMethods: [
				{ id: "oauth", name: "OAuth login" },
				{
					id: "api-key",
					name: "API key",
					description: "Use an API key",
					vars: [{ name: "GEMINI_API_KEY" }],
					link: "https://example.com/keys",
				},
				{ id: "term", name: "Terminal", type: "terminal", args: ["login"] },
			] as AcpAuthMethod[],
		});
		expect(screen.getByText("Checking…")).toBeTruthy();
		expect(screen.getByText("Credential management")).toBeTruthy();
		expect(
			screen.getByText(
				"These are login methods advertised by the agent, not a sign-in status. If the agent is already signed in, no action is needed.",
			),
		).toBeTruthy();
		expect(screen.getByText("OAuth login")).toBeTruthy();
		expect(
			screen.getByText("Required environment: GEMINI_API_KEY"),
		).toBeTruthy();
		expect(screen.getByText("Credential command: gemini login")).toBeTruthy();
		expect(
			(
				screen.getByRole("link", {
					name: "Open credential page",
				}) as HTMLAnchorElement
			).href,
		).toContain("https://example.com/keys");
		// oauth and api-key both lack a type, so each renders a login action.
		fireEvent.click(
			screen.getAllByRole("button", { name: "Add or replace credentials" })[0],
		);
		expect(onInspect).toHaveBeenCalledWith("oauth");
	});

	it("presents OpenCode as a featured CLI-backed ACP integration", () => {
		renderCard({
			item: makeItem({
				id: "opencode",
				providerId: "acp:opencode",
				name: "OpenCode",
				command: "opencode",
				args: ["acp"],
				resolvedExecutable: "C:\\nvm4w\\nodejs\\opencode.cmd",
			}),
			configured: { id: "opencode" } as AcpAgentConfig,
			agentInfo: { name: "OpenCode", version: "1.18.15" },
			optionsRefreshed: true,
		});

		expect(screen.getByText("Featured integration")).toBeTruthy();
		expect(screen.getByText("OpenCode ACP initialized")).toBeTruthy();
		expect(screen.getByText("C:\\nvm4w\\nodejs\\opencode.cmd")).toBeTruthy();
		expect(screen.getByText("opencode acp")).toBeTruthy();
		expect(screen.getByText("installed OpenCode 1.18.15")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Refresh models & modes" }),
		).toBeTruthy();
		expect(
			screen.getByText("Models and modes refreshed for this workspace."),
		).toBeTruthy();
		expect(screen.getByText("Available through ACP")).toBeTruthy();
		expect(screen.getByText("Connection boundary")).toBeTruthy();
		expect(screen.getByText("Model visibility")).toBeTruthy();
		expect(
			screen.getByText(
				"Applies only to OpenCode ACP sessions launched from this Hlid integration. Standalone OpenCode and CLIProxy keep their own model configuration. Defaults excluded by the filter reset to OpenCode's provider default.",
			),
		).toBeTruthy();
	});

	it("stages OpenCode model selections until one apply action", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			models: [
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
				{ value: "openai/gpt-5.4", label: "GPT-5.4" },
			],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		fireEvent.click(
			screen.getByRole("checkbox", { name: /Claude Sonnet 4\.6/i }),
		);
		expect(onUpdateOverride).not.toHaveBeenCalled();
		expect(
			screen.getByText("Changes are staged until you apply them."),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Apply model visibility" }),
		);
		expect(onUpdateOverride).toHaveBeenCalledOnce();
		expect(onUpdateOverride).toHaveBeenCalledWith({
			model_filter: {
				mode: "hide",
				models: ["anthropic/claude-sonnet-4-6"],
			},
		});
	});

	it("treats an empty hide selection as Use all without persisting", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		expect(
			screen.getByText(
				"Choose at least one model before applying Hide selected.",
			),
		).toBeTruthy();
		const apply = screen.getByRole("button", {
			name: "Apply model visibility",
		}) as HTMLButtonElement;
		expect(apply.disabled).toBe(true);
		fireEvent.click(apply);
		expect(onUpdateOverride).not.toHaveBeenCalled();
	});

	it("rejects hiding every currently known OpenCode model", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			models: [
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
				{ value: "openai/gpt-5.4", label: "GPT-5.4" },
			],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		fireEvent.click(
			screen.getByRole("checkbox", { name: /Claude Sonnet 4\.6/i }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: /GPT-5\.4/i }));

		expect(
			screen.getByText(
				"Hide selected cannot hide every currently known model. Disable OpenCode instead.",
			),
		).toBeTruthy();
		const apply = screen.getByRole("button", {
			name: "Apply model visibility",
		}) as HTMLButtonElement;
		expect(apply.disabled).toBe(true);
		fireEvent.click(apply);
		expect(onUpdateOverride).not.toHaveBeenCalled();
	});

	it("allows replacing a narrowed allowlist with a hide filter", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: {
					mode: "only",
					models: ["openai/gpt-5.4"],
				},
			} as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		expect(
			screen.queryByText(/cannot hide every currently known model/i),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Apply model visibility" }),
		);

		expect(onUpdateOverride).toHaveBeenCalledWith({
			model_filter: {
				mode: "hide",
				models: ["openai/gpt-5.4"],
			},
		});
	});

	it("can replace a narrowed catalog with a separately discovered full model list", async () => {
		const discover = vi.fn().mockResolvedValue([
			{
				value: "anthropic/claude-sonnet-4-6",
				label: "Claude Sonnet 4.6",
			},
			{ value: "openai/gpt-5.4", label: "GPT-5.4" },
		]);
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: {
					mode: "only",
					models: ["openai/gpt-5.4"],
				},
			} as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
			onDiscoverModels: discover,
		});

		expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);

		expect(await screen.findByText("Claude Sonnet 4.6")).toBeTruthy();
		expect(
			screen.getByText("Full OpenCode model list refreshed."),
		).toBeTruthy();
		expect(discover).toHaveBeenCalledOnce();
	});

	it("keeps the last model list when full discovery fails", async () => {
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: {
					mode: "hide",
					models: ["openai/gpt-5.4"],
				},
			} as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
			onDiscoverModels: vi
				.fn()
				.mockRejectedValue(new Error("Unfiltered discovery timed out")),
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);

		expect(
			await screen.findByText(
				"Unfiltered discovery timed out. Showing the last available model list.",
			),
		).toBeTruthy();
		expect(screen.getByRole("checkbox", { name: /GPT-5\.4/i })).toBeTruthy();
	});

	it("ignores a full-model response after the runtime configuration changes", async () => {
		let resolveDiscovery: ((models: AcpModelOption[]) => void) | undefined;
		const discover = vi.fn(
			() =>
				new Promise<AcpModelOption[]>((resolve) => {
					resolveDiscovery = resolve;
				}),
		);
		const { rerenderCard } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
			onDiscoverModels: discover,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);
		rerenderCard({ configurationCurrent: false });
		await act(async () => {
			resolveDiscovery?.([
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
			]);
		});

		expect(discover).toHaveBeenCalledOnce();
		expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
		expect(
			screen.queryByText("Full OpenCode model list refreshed."),
		).toBeNull();
	});

	it("ignores a full-model response after the registry invocation changes", async () => {
		let resolveDiscovery: ((models: AcpModelOption[]) => void) | undefined;
		const discover = vi.fn(
			() =>
				new Promise<AcpModelOption[]>((resolve) => {
					resolveDiscovery = resolve;
				}),
		);
		const original = makeItem({
			id: "opencode",
			name: "OpenCode",
			command: "opencode",
			args: ["acp"],
		});
		const { rerenderCard } = renderCard({
			item: original,
			configured: { id: "opencode" } as AcpAgentConfig,
			onDiscoverModels: discover,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);
		rerenderCard({ item: { ...original, args: ["acp", "--new"] } });
		await act(async () => {
			resolveDiscovery?.([
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
			]);
		});

		expect(discover).toHaveBeenCalledOnce();
		expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
		expect(
			screen.queryByText("Full OpenCode model list refreshed."),
		).toBeNull();
	});

	it("caps model-filter selections at the schema limit", () => {
		const selectedModels = Array.from(
			{ length: 256 },
			(_, index) => `provider/model-${index}`,
		);
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: { mode: "only", models: selectedModels },
			} as AcpAgentConfig,
			models: [{ value: "provider/new-model", label: "New model" }],
		});

		const newModel = screen.getByRole("checkbox", {
			name: /New model/i,
		}) as HTMLInputElement;
		expect(newModel.disabled).toBe(true);
		expect(
			screen.getByText(
				"You can select up to 256 models. Clear one before selecting another.",
			),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("checkbox", { name: /provider\/model-0/i }),
		);
		expect(newModel.disabled).toBe(false);
	}, 15_000);

	it("rejects an empty OpenCode allowlist", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Only selected/i }));
		expect(
			screen.getByText(
				"Choose at least one model before applying Only selected.",
			),
		).toBeTruthy();
		const apply = screen.getByRole("button", {
			name: "Apply model visibility",
		}) as HTMLButtonElement;
		expect(apply.disabled).toBe(true);
		fireEvent.click(apply);
		expect(onUpdateOverride).not.toHaveBeenCalled();
	});

	it("preserves saved models missing from the current OpenCode catalog", () => {
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: {
					mode: "only",
					models: ["retired/provider-model"],
				},
			} as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
		});

		expect(
			(
				screen.getByRole("checkbox", {
					name: /retired\/provider-model/i,
				}) as HTMLInputElement
			).checked,
		).toBe(true);
		expect(
			screen.getByText("Saved, but not currently advertised by OpenCode"),
		).toBeTruthy();
	});

	it("keeps an unavailable saved model reversible while edits are staged", () => {
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model_filter: {
					mode: "only",
					models: ["retired/provider-model"],
				},
			} as AcpAgentConfig,
			models: [{ value: "openai/gpt-5.4", label: "GPT-5.4" }],
		});

		const retired = screen.getByRole("checkbox", {
			name: /retired\/provider-model/i,
		}) as HTMLInputElement;
		fireEvent.click(retired);
		expect(retired.checked).toBe(false);
		expect(
			screen.getByRole("checkbox", { name: /retired\/provider-model/i }),
		).toBeTruthy();
		fireEvent.click(retired);
		expect(retired.checked).toBe(true);
	});

	it("clears OpenCode defaults excluded by an applied allowlist", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model: "anthropic/claude-sonnet-4-6",
				recap_model: "anthropic/claude-sonnet-4-6",
			} as AcpAgentConfig,
			models: [
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
				{ value: "openai/gpt-5.4", label: "GPT-5.4" },
			],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Only selected/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /GPT-5\.4/i }));
		fireEvent.click(
			screen.getByRole("button", { name: "Apply model visibility" }),
		);

		expect(onUpdateOverride).toHaveBeenCalledWith({
			model_filter: {
				mode: "only",
				models: ["openai/gpt-5.4"],
			},
			model: undefined,
			recap_model: undefined,
		});
	});

	it("clears an OpenCode default selected for hiding", () => {
		const { onUpdateOverride } = renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: {
				id: "opencode",
				model: "openai/gpt-5.4",
			} as AcpAgentConfig,
			models: [
				{ value: "openai/gpt-5.4", label: "GPT-5.4" },
				{
					value: "anthropic/claude-sonnet-4-6",
					label: "Claude Sonnet 4.6",
				},
			],
		});

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /GPT-5\.4/i }));
		fireEvent.click(
			screen.getByRole("button", { name: "Apply model visibility" }),
		);

		expect(onUpdateOverride).toHaveBeenCalledWith({
			model_filter: {
				mode: "hide",
				models: ["openai/gpt-5.4"],
			},
			model: undefined,
		});
	});

	it("does not show OpenCode model visibility for another ACP agent", () => {
		renderCard({
			configured: { id: "gemini" } as AcpAgentConfig,
			models: [{ value: "gemini/2.5-pro", label: "Gemini 2.5 Pro" }],
		});

		expect(screen.queryByText("Model visibility")).toBeNull();
	});

	it("explains that OpenCode Desktop does not replace the required CLI", () => {
		renderCard({
			item: makeItem({
				id: "opencode",
				providerId: "acp:opencode",
				name: "OpenCode",
				available: false,
				unavailableReason: "opencode is not installed",
				installGuidance: "Install OpenCode and place it on PATH",
			}),
		});

		expect(screen.getByText("OpenCode CLI not found")).toBeTruthy();
		expect(
			screen.getByText(
				"OpenCode Desktop and the OpenCode CLI are separate installs. Hlid needs the CLI in the same environment where Hlid runs.",
			),
		).toBeTruthy();
		expect(screen.getByText("opencode is not installed")).toBeTruthy();
	});

	it("does not mistake OpenCode credential actions for signed-out status", () => {
		renderCard({
			item: makeItem({ id: "opencode", name: "OpenCode" }),
			configured: { id: "opencode" } as AcpAgentConfig,
			authMethods: [{ id: "login", name: "OpenCode login" }],
		});

		expect(
			screen.getByText(
				"OpenCode advertises these credential actions; it does not mean you are signed out. Use them only to add or replace credentials.",
			),
		).toBeTruthy();
	});
});
