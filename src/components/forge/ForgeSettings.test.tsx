// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationNamesProvider } from "#/components/nav/NavigationNamesContext";
import { resolveNavigationLabels } from "#/lib/navigationNames";
import { TAN_THEME } from "#/lib/theme";
import { ForgeSettings } from "./ForgeSettings";

vi.mock("#/components/forge/SystemSection", () => ({
	SystemSection: ({ view }: { view?: string }) => (
		<div>System section: {view ?? "overview"}</div>
	),
}));

vi.mock("#/components/forge/UpdatesSection", () => ({
	UpdatesSection: () => <div>Updates section</div>,
}));

vi.mock("#/components/forge/AcpSection", () => ({
	AcpSection: ({
		workspaceConfigurationCurrent,
		ollamaModelCount,
		onOpenOllama,
	}: {
		workspaceConfigurationCurrent?: boolean;
		ollamaModelCount?: number;
		onOpenOllama?: () => void;
	}) => (
		<div>
			ACP catalog content ·{" "}
			{workspaceConfigurationCurrent ? "runtime current" : "runtime pending"}
			{" · "}
			{ollamaModelCount ?? 0} Ollama models
			{onOpenOllama && (
				<button type="button" onClick={onOpenOllama}>
					Manage Ollama from OpenCode
				</button>
			)}
		</div>
	),
}));
vi.mock("#/components/forge/ApiSection", () => ({
	ApiSection: () => <div>API reference content</div>,
}));
vi.mock("#/components/forge/AutoSleepSection", () => ({
	AutoSleepSection: () => <div>Auto sleep content</div>,
}));
vi.mock("#/components/forge/BrowserProfileSection", () => ({
	BrowserProfileSection: () => <div>Browser profile content</div>,
}));
vi.mock("#/components/forge/ClaudeSection", () => ({
	ClaudeSection: () => <div>Claude content</div>,
	ComputerUseSection: () => <div>Computer Use content</div>,
}));
vi.mock("#/components/forge/EventLogSection", () => ({
	EventLogSection: () => <div>Event log content</div>,
}));
vi.mock("#/components/forge/ExtensionsSection", () => ({
	ExtensionsSection: ({ destination }: { destination?: string }) => (
		<div>Extensions content · {destination ?? "none"}</div>
	),
}));
vi.mock("#/components/forge/InstructionFilesSection", () => ({
	InstructionFilesSection: (props: {
		vaultProvider: string;
		savedVaultProvider?: string;
	}) => (
		<div>
			Agent Instructions content · {props.vaultProvider} ·{" "}
			{props.savedVaultProvider ?? "unset"}
		</div>
	),
}));
vi.mock("#/components/forge/McpSection", () => ({
	McpSection: () => <div>MCP content</div>,
}));
vi.mock("#/components/forge/NetworkSection", () => ({
	NetworkSection: () => <div>Network content</div>,
}));
vi.mock("#/components/forge/NavigationNamesSection", () => ({
	NavigationNamesSection: () => (
		<div id="forge-section-navigation-names" tabIndex={-1}>
			Navigation names content
		</div>
	),
}));
vi.mock("#/components/forge/NotificationsSection", () => ({
	NotificationsSection: () => (
		<div id="forge-section-notifications" tabIndex={-1}>
			Notifications content
		</div>
	),
}));
vi.mock("#/components/forge/OllamaSection", () => ({
	OllamaSection: ({
		openCode,
		onOpenCodeSetup,
	}: {
		openCode?: { id: string };
		onOpenCodeSetup: () => void;
	}) => (
		<div>
			Ollama content ·{" "}
			{openCode ? "OpenCode configured" : "OpenCode not configured"}
			<button type="button" onClick={onOpenCodeSetup}>
				{openCode ? "Configure OpenCode" : "Set up OpenCode"}
			</button>
		</div>
	),
}));
vi.mock("#/components/forge/PricingSection", () => ({
	PricingSection: () => <div>Pricing catalog content</div>,
}));
vi.mock("#/components/forge/SecuritySection", () => ({
	SecuritySection: () => <div>Security content</div>,
}));
vi.mock("#/components/forge/SessionSection", () => ({
	SessionSection: ({ view }: { view?: string }) => (
		<div>Session section: {view}</div>
	),
}));
vi.mock("#/components/forge/UiSection", () => ({
	UiSection: () => <div>UI content</div>,
}));
vi.mock("#/components/forge/UmbodSection", () => ({
	UmbodSection: () => <div>Umbod content</div>,
}));
vi.mock("#/components/forge/VaultSection", () => ({
	VaultSection: () => (
		<div>
			Vault content
			<div data-forge-setting-label="skills folder" tabIndex={-1}>
				Skills folder control
			</div>
			<div data-forge-setting-label="memory folder" tabIndex={-1}>
				Memory folder control
			</div>
		</div>
	),
}));
vi.mock("#/components/forge/VocabSection", () => ({
	VocabSection: () => <div>Vocabulary content</div>,
}));
vi.mock("#/components/forge/VoiceSection", () => ({
	VoiceSection: () => (
		<div>
			<div id="forge-setting-recording-hotkey" tabIndex={-1}>
				Voice content
			</div>
			<section
				id="forge-section-local-conversation"
				data-forge-section="forge-section-local-conversation"
				tabIndex={-1}
			>
				Local conversation content
			</section>
		</div>
	),
}));

afterEach(cleanup);

describe("ForgeSettings search", () => {
	it("opens a precise setting destination instead of filtering categories", () => {
		render(
			<ForgeSettings
				initial={{} as never}
				state={
					{
						saving: false,
						dirty: false,
						error: null,
						savedMsg: null,
						save: vi.fn(),
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
					} as never
				}
			/>,
		);

		expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "restart" },
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: /Restart Hlid.*Advanced.*Danger zone/i,
			}),
		);
		expect(screen.getByRole("heading", { name: "Advanced" })).toBeTruthy();
		expect(screen.getByText("System section: advanced")).toBeTruthy();
	});

	it("finds labels that were absent from the old category index", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Recording hotkey" },
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: /Recording hotkey.*Experience.*Voice input/i,
			}),
		);
		expect(screen.getByRole("heading", { name: "Experience" })).toBeTruthy();
		expect(screen.getByText("Voice content")).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-setting-recording-hotkey"),
		);
	});

	it("opens and focuses navigation name settings from search", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Navigation names" },
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: /Navigation names.*Experience.*Navigation names/i,
			}),
		);
		expect(screen.getByText("Navigation names content")).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-section-navigation-names"),
		);
	});

	it("focuses Local conversation from the Experience section navigation", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "experience" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Local conversation" }));
		await waitFor(() =>
			expect(document.activeElement?.id).toBe(
				"forge-section-local-conversation",
			),
		);
	});

	it("focuses a rendered control discovered from the setting label", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Memory folder" },
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: /Memory folder.*Workspace.*Vault/i,
			}),
		);
		const control = screen.getByText("Memory folder control");
		await waitFor(() => expect(document.activeElement).toBe(control));

		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Skills folder" },
		});
		fireEvent.click(
			screen.getByRole("button", {
				name: /Skills folder.*Workspace.*Vault/i,
			}),
		);
		const nextControl = screen.getByText("Skills folder control");
		await waitFor(() => expect(document.activeElement).toBe(nextControl));
	});

	it("focuses a custom theme color from search", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Background color" },
		});
		fireEvent.click(
			screen.getByRole("button", {
				name: /Background color.*Experience.*Custom theme/i,
			}),
		);

		const color = document.querySelector<HTMLElement>(
			'[data-forge-setting-label="background color"]',
		);
		await waitFor(() => expect(document.activeElement).toBe(color));
	});

	it("labels and limits truncated search results", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "agent" },
		});

		expect(
			screen.getByText(
				/Showing first 12 results.*Results are truncated.*Narrow your search/i,
			),
		).toBeTruthy();
		const results = screen
			.getByRole("heading", { name: "Search settings" })
			.closest("section");
		expect(results?.querySelectorAll("button")).toHaveLength(12);
	});

	it("opens nested Developer tools directly from search", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "API Reference" },
		});

		fireEvent.click(
			screen.getAllByRole("button", { name: /API Reference/i })[0],
		);
		expect(screen.getByRole("heading", { name: "Developer" })).toBeTruthy();
		expect(screen.getByText("API reference content")).toBeTruthy();
		expect(screen.getByRole("option", { name: "Experience" })).toBeTruthy();
	});

	it("hides conditional settings when their controls are unavailable", () => {
		renderSettings({
			claude: { vaultProvider: "codex" },
			voice: { input_provider: "codex" },
		});
		const search = screen.getByRole("textbox", { name: "Search settings" });

		for (const query of [
			"AI subagent progress summaries",
			"Interactive mode",
			"Claude peer inbox",
			"Whisper threads",
		]) {
			fireEvent.change(search, { target: { value: query } });
			const resultLabels = Array.from(
				screen
					.getByRole("heading", { name: "Search settings" })
					.closest("section")
					?.querySelectorAll("button > span:first-child") ?? [],
			).map((element) => element.textContent);
			expect(resultLabels).not.toContain(query);
		}
	});

	it("keeps conditional settings searchable while their controls render", () => {
		renderSettings({
			claude: { vaultProvider: "claude" },
			voice: { input_provider: "local" },
		});
		const search = screen.getByRole("textbox", { name: "Search settings" });

		for (const query of ["Interactive mode", "Whisper threads"]) {
			fireEvent.change(search, { target: { value: query } });
			expect(
				screen.getByRole("button", { name: new RegExp(query, "i") }),
			).toBeTruthy();
		}
	});

	it("routes the desktop theme copy action to the mobile palette", () => {
		const onNavigationChange = vi.fn();
		renderSettings(
			{},
			{
				navigation: { category: "overview" },
				onNavigationChange,
			},
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
			target: { value: "Copy desktop custom theme" },
		});
		fireEvent.click(
			screen.getByRole("button", {
				name: /Copy desktop custom theme.*Experience.*Custom theme/i,
			}),
		);
		expect(onNavigationChange).toHaveBeenLastCalledWith({
			category: "experience",
			section: "custom-theme",
			setting: "copy-desktop-custom-theme",
			view: "theme",
			target: "mobile",
		});
	});

	it("does not warn when an external route transition synchronously unmounts Forge", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			let view!: ReturnType<typeof renderSettings>;
			view = renderSettings(
				{},
				{
					navigation: { category: "overview" },
					onNavigationChange: () => view.unmount(),
				},
			);
			fireEvent.change(
				screen.getByRole("textbox", { name: "Search settings" }),
				{
					target: { value: "API Reference" },
				},
			);

			fireEvent.click(
				screen.getAllByRole("button", { name: /API Reference/i })[0],
			);

			expect(
				consoleError.mock.calls.some(([message]) =>
					String(message).includes("hasn't mounted yet"),
				),
			).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("offers an explicit retry after an autosave failure", () => {
		const save = vi.fn();
		render(
			<ForgeSettings
				initial={{} as never}
				state={
					{
						saving: false,
						dirty: true,
						error: "Could not write config",
						savedMsg: null,
						save,
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
					} as never
				}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
		expect(save).toHaveBeenCalledOnce();
	});

	it("shows a runtime warning without hiding a required restart", () => {
		const warning = "Codex runtime synchronization returned 503.";
		render(
			<ForgeSettings
				initial={{} as never}
				state={
					{
						saving: false,
						dirty: false,
						error: null,
						warning,
						savedMsg: "restart",
						save: vi.fn(),
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
					} as never
				}
			/>,
		);

		expect(screen.getByText(`Changes saved. ${warning}`)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Restart required" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
	});

	it("offers an ACP runtime retry after the config was persisted with a sync warning", () => {
		const save = vi.fn();
		render(
			<ForgeSettings
				initial={{} as never}
				state={
					{
						saving: false,
						dirty: false,
						error: null,
						warning:
							"ACP runtime synchronization failed: provider registry unavailable.",
						acpRuntimePending: true,
						savedMsg: "saved",
						save,
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
					} as never
				}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Retry ACP sync" }));
		expect(save).toHaveBeenCalledOnce();
	});

	it("wraps long header statuses without hiding recovery actions", () => {
		const error =
			"Could not save a configuration path with anextremelylongunbrokentokenfromthebackend";
		render(
			<ForgeSettings
				initial={{} as never}
				inventoryStatus="unavailable"
				state={
					{
						saving: false,
						dirty: true,
						error,
						savedMsg: null,
						save: vi.fn(),
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
					} as never
				}
			/>,
		);

		const errorText = screen.getByText(error);
		const headerLayout = errorText.closest("header")?.firstElementChild;
		expect(headerLayout?.className).toContain("flex-wrap");
		expect(errorText.className).toContain("[overflow-wrap:anywhere]");
		expect(
			screen.getByRole("textbox", { name: "Search settings" }).className,
		).toContain("min-w-0");
		expect(screen.getByRole("button", { name: "Retry save" })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Inventory unavailable/i }),
		).toBeTruthy();
	});

	it("keeps a slow inventory refresh non-actionable until it settles", () => {
		renderSettings({}, { inventoryStatus: "slow" });

		expect(
			screen.getByText("System inventory is still refreshing…"),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Inventory unavailable/i }),
		).toBeNull();
	});
});

function renderSettings(
	stateOverrides: Record<string, unknown> = {},
	propsOverrides: Partial<ComponentProps<typeof ForgeSettings>> = {},
	viewMode: "full" | "simple" = "full",
) {
	return render(
		<NavigationNamesProvider
			initialLabels={resolveNavigationLabels()}
			initialViewMode={viewMode}
		>
			<ForgeSettings
				initial={
					{
						providers: [],
						accountInfo: null,
						acpCatalog: [],
						cwd: "/tmp/vault",
						voiceInfo: null,
						vault_provider: "claude",
					} as never
				}
				state={
					{
						saving: false,
						dirty: false,
						error: null,
						warning: null,
						acpRuntimePending: false,
						savedMsg: null,
						save: vi.fn(),
						claude: { vaultProvider: "claude" },
						codex: {},
						vault: { path: "/tmp/vault" },
						persistedVaultPath: "/tmp/vault",
						vocab: {},
						autoSleep: {},
						projectPreview: {},
						diagnostics: { event_log: true },
						server: {},
						ui: {
							theme: "tan",
							mobileTheme: "same",
							customTheme: TAN_THEME,
							mobileCustomTheme: TAN_THEME,
						},
						voice: {},
						acpAgents: [],
						persistedAcpAgents: [],
						ollama: undefined,
						umbod: {},
						changeClaude: vi.fn(),
						setVault: vi.fn(),
						setVocab: vi.fn(),
						setAutoSleep: vi.fn(),
						setProjectPreview: vi.fn(),
						setDiagnostics: vi.fn(),
						setServer: vi.fn(),
						setUi: vi.fn(),
						setVoice: vi.fn(),
						setAcpAgents: vi.fn(),
						setOllama: vi.fn(),
						setUmbod: vi.fn(),
						...stateOverrides,
					} as never
				}
				{...propsOverrides}
			/>
		</NavigationNamesProvider>,
	);
}

describe("ForgeSettings Simple view", () => {
	it("shows readiness and common settings instead of the full category browser", () => {
		renderSettings({}, {}, "simple");

		expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Ready to use" })).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Common settings" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "All settings" })).toBeTruthy();
		expect(
			screen.queryByRole("combobox", { name: "Forge category" }),
		).toBeNull();
		expect(screen.queryByText("Browse settings")).toBeNull();
	});

	it("reveals the existing Forge interface from All settings", () => {
		renderSettings({}, {}, "simple");
		fireEvent.click(screen.getByRole("button", { name: "All settings" }));

		expect(
			screen.getByRole("combobox", { name: "Forge category" }),
		).toBeTruthy();
		expect(screen.getByText("Browse settings")).toBeTruthy();
	});

	it("bypasses the Simple landing for a direct advanced destination", () => {
		renderSettings(
			{},
			{ navigation: { category: "advanced", section: "danger-zone" } },
			"simple",
		);

		expect(screen.getByRole("heading", { name: "Advanced" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "All settings" })).toBeNull();
	});
});

describe("ForgeSettings category navigation", () => {
	it("passes reload-safe marketplace destinations to Extensions", () => {
		renderSettings(
			{},
			{
				navigation: {
					category: "extensions",
					section: "provider-extensions",
					setting: "marketplace-sparse-paths",
				},
			},
		);

		expect(
			screen.getByText("Extensions content · marketplace-sparse-paths"),
		).toBeTruthy();
	});

	it("keeps nested Forge controls touch scoped and clear of the mobile nav", () => {
		const { container } = renderSettings();
		const touchSurface = container.querySelector<HTMLElement>(
			"[data-forge-touch-surface]",
		);
		expect(touchSurface).not.toBeNull();
		expect(touchSurface?.getAttribute("data-scroll-restoration-id")).toBe(
			"forge-settings",
		);

		const content = touchSurface?.firstElementChild as HTMLElement | undefined;
		expect(content?.className).toContain("pb-20");
		expect(content?.className).toContain("md:pb-6");
	});

	it("passes current and saved vault provider context to instruction files", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "agents" },
		});

		expect(
			screen.getByText("Agent Instructions content · claude · claude"),
		).toBeTruthy();
	});

	it("places Browser profile above Computer Use", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "agents" },
		});

		const content = document.body.textContent ?? "";
		expect(content.indexOf("Claude content")).toBeLessThan(
			content.indexOf("Browser profile content"),
		);
		expect(content.indexOf("Browser profile content")).toBeLessThan(
			content.indexOf("Computer Use content"),
		);
		expect(content.indexOf("Computer Use content")).toBeLessThan(
			content.indexOf("Auto sleep content"),
		);
	});

	it("renders every top-level category selected from the mobile selector", () => {
		renderSettings();
		const selector = screen.getByRole("combobox", {
			name: "Forge category",
		});

		for (const category of [
			"Workspace",
			"Agents",
			"Access",
			"Experience",
			"Integrations",
			"Extensions",
			"Developer",
			"Advanced",
		]) {
			fireEvent.change(selector, { target: { value: category.toLowerCase() } });
			expect(screen.getByRole("heading", { name: category })).toBeTruthy();
		}
	});

	it("opens and returns from the Ollama, ACP, and Umbod integration pages", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "integrations" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Open Ollama" }));
		expect(screen.getByRole("heading", { name: "Ollama" })).toBeTruthy();
		expect(screen.getByText(/Ollama content/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));

		fireEvent.click(screen.getByRole("button", { name: "Open integrations" }));
		expect(
			screen.getByRole("heading", { name: "OpenCode and ACP integrations" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));

		fireEvent.click(screen.getByRole("button", { name: "Open Umbod" }));
		expect(screen.getByRole("heading", { name: "Umbod" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));
		expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
	});

	it("moves directly between Ollama and OpenCode setup", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "integrations" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Open Ollama" }));
		fireEvent.click(screen.getByRole("button", { name: "Set up OpenCode" }));
		expect(
			screen.getByRole("heading", { name: "OpenCode and ACP integrations" }),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Manage Ollama from OpenCode" }),
		);
		expect(screen.getByRole("heading", { name: "Ollama" })).toBeTruthy();
	});

	it("keeps Custom theme and ACP section chips on their category landings", async () => {
		renderSettings();
		const selector = screen.getByRole("combobox", { name: "Forge category" });
		const rail = screen.getByLabelText("Forge categories");
		const railButton = (label: string) =>
			Array.from(rail.querySelectorAll("button")).find(
				(button) => button.textContent === label,
			);

		fireEvent.change(selector, { target: { value: "experience" } });
		fireEvent.click(screen.getByRole("button", { name: "Custom theme" }));
		expect(screen.getByRole("heading", { name: "Experience" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "← Experience" })).toBeNull();
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-section-custom-theme"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Open theme editor" }));
		expect(screen.getByRole("button", { name: "← Experience" })).toBeTruthy();
		expect(railButton("Experience")?.getAttribute("aria-current")).toBe("page");
		fireEvent.click(screen.getByRole("button", { name: "← Experience" }));
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-section-custom-theme"),
		);

		fireEvent.change(selector, { target: { value: "integrations" } });
		fireEvent.click(
			screen.getByRole("button", { name: "OpenCode and ACP agents" }),
		);
		expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "← Integrations" })).toBeNull();
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-section-opencode-acp"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Open integrations" }));
		expect(screen.getByRole("button", { name: "← Integrations" })).toBeTruthy();
		expect(railButton("Integrations")?.getAttribute("aria-current")).toBe(
			"page",
		);
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("forge-section-opencode-acp"),
		);
		expect(railButton("Integrations")?.getAttribute("aria-current")).toBe(
			"page",
		);
	});

	it.each([
		["Apps and Connectors", "forge-section-apps-connectors", "Open Apps"],
		["Ollama", "forge-section-ollama", "Open Ollama"],
		["Umbod policy and activity", "forge-section-umbod", "Open Umbod"],
	])("keeps the %s section chip on its on-page landing", async (chipLabel, landingId, openLabel) => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "integrations" },
		});

		fireEvent.click(screen.getByRole("button", { name: chipLabel }));
		expect(screen.queryByRole("button", { name: "← Integrations" })).toBeNull();
		await waitFor(() => expect(document.activeElement?.id).toBe(landingId));

		fireEvent.click(screen.getByRole("button", { name: openLabel }));
		expect(screen.getByRole("button", { name: "← Integrations" })).toBeTruthy();
	});

	it.each([
		[
			"Apps",
			{
				category: "integrations" as const,
				section: "apps-connectors",
				view: "apps" as const,
			},
			"Integrations",
			"Apps and Connectors",
			"Apps and Connectors",
		],
		[
			"Ollama",
			{
				category: "integrations" as const,
				section: "ollama",
				view: "ollama" as const,
			},
			"Integrations",
			"Ollama",
			"Ollama",
		],
		[
			"Umbod",
			{
				category: "integrations" as const,
				section: "umbod",
				view: "umbod" as const,
			},
			"Integrations",
			"Umbod policy and activity",
			"Umbod",
		],
		[
			"ACP",
			{
				category: "integrations" as const,
				section: "opencode-acp",
				view: "acp" as const,
			},
			"Integrations",
			"OpenCode and ACP agents",
			"OpenCode and ACP integrations",
		],
		[
			"theme",
			{
				category: "experience" as const,
				section: "custom-theme",
				view: "theme" as const,
			},
			"Experience",
			"Custom theme",
			"Custom Theme",
		],
	])("retains the %s nested view's category and section navigation context", (_label, navigation, categoryLabel, sectionLabel, nestedHeading) => {
		renderSettings({}, { navigation });

		expect(
			screen.getByRole("heading", { level: 1, name: categoryLabel }),
		).toBeTruthy();
		const sectionNavigation = screen.getByRole("navigation", {
			name: `${categoryLabel} settings`,
		});
		expect(
			within(sectionNavigation)
				.getByRole("button", { name: sectionLabel })
				.getAttribute("aria-current"),
		).toBe("location");
		expect(
			screen.getByRole("heading", { level: 2, name: nestedHeading }),
		).toBeTruthy();
	});

	it.each([
		[
			"theme",
			{
				category: "experience" as const,
				section: "custom-theme",
				view: "theme" as const,
			},
			"forge-view-theme",
		],
		[
			"ACP",
			{
				category: "integrations" as const,
				section: "opencode-acp",
				view: "acp" as const,
			},
			"forge-view-acp",
		],
	])("focuses a direct %s editor deep link", async (_label, navigation, id) => {
		renderSettings({}, { navigation });
		await waitFor(() => expect(document.activeElement?.id).toBe(id));
	});

	it("keeps ACP alignment inside the Forge scroller without shifting the app shell", async () => {
		const { container } = renderSettings(
			{},
			{
				navigation: {
					category: "integrations",
					section: "opencode-acp",
					view: "acp",
				},
			},
		);
		const scroller = container.querySelector<HTMLElement>(
			'[data-scroll-restoration-id="forge-settings"]',
		);
		const target = document.getElementById("forge-view-acp");
		expect(scroller).not.toBeNull();
		expect(target).not.toBeNull();
		if (!scroller || !target) return;

		const scrollIntoView = vi.fn(() => {
			// Models Android moving an overflow-hidden ancestor when a delayed
			// destination alignment asks the browser to scroll every ancestor.
			container.scrollTop = 136;
		});
		Object.defineProperty(target, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		const scrollTo = vi.fn();
		Object.defineProperty(scroller, "scrollTo", {
			configurable: true,
			value: scrollTo,
		});
		scroller.scrollTop = 40;
		container.scrollTop = 136;
		vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
			top: 100,
		} as DOMRect);
		vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
			top: 360,
		} as DOMRect);

		await waitFor(() => expect(document.activeElement).toBe(target));
		await new Promise((resolve) => window.setTimeout(resolve, 250));

		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(scrollTo).toHaveBeenCalledWith({ top: 300 });
		expect(container.scrollTop).toBe(0);
	});

	it.each([
		[
			{
				category: "integrations" as const,
				section: "apps-connectors",
				view: "apps" as const,
			},
			"← Integrations",
			{ category: "integrations", section: "apps-connectors" },
		],
		[
			{
				category: "integrations" as const,
				section: "umbod",
				view: "umbod" as const,
			},
			"← Integrations",
			{ category: "integrations", section: "umbod" },
		],
		[
			{
				category: "experience" as const,
				section: "custom-theme",
				view: "theme" as const,
			},
			"← Experience",
			{ category: "experience", section: "custom-theme" },
		],
		[
			{
				category: "integrations" as const,
				section: "opencode-acp",
				view: "acp" as const,
			},
			"← Integrations",
			{ category: "integrations", section: "opencode-acp" },
		],
	])("replaces the nested editor entry when using inline Back", (navigation, backLabel, landing) => {
		const onNavigationChange = vi.fn();
		renderSettings({}, { navigation, onNavigationChange });
		fireEvent.click(screen.getByRole("button", { name: backLabel }));
		expect(onNavigationChange).toHaveBeenCalledWith(landing, {
			replace: true,
		});
	});

	it.each([
		[
			{ category: "integrations" as const, section: "apps-connectors" },
			"Open Apps",
			"apps",
		],
		[
			{ category: "integrations" as const, section: "umbod" },
			"Open Umbod",
			"umbod",
		],
		[
			{ category: "integrations" as const, section: "opencode-acp" },
			"Open integrations",
			"acp",
		],
		[
			{ category: "experience" as const, section: "custom-theme" },
			"Open theme editor",
			"theme",
		],
	])("replaces an existing %s landing when opening its nested view", (navigation, openLabel, view) => {
		const onNavigationChange = vi.fn();
		renderSettings({}, { navigation, onNavigationChange });

		fireEvent.click(screen.getByRole("button", { name: openLabel }));

		expect(onNavigationChange).toHaveBeenCalledWith(
			{ ...navigation, view },
			{ replace: true },
		);
	});

	it("keeps the ACP catalog live controls gated while runtime sync is pending", () => {
		renderSettings({ acpRuntimePending: true });
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "integrations" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Open integrations" }));

		expect(
			screen.getByText(/ACP catalog content · runtime pending/),
		).toBeTruthy();
	});

	it("switches between developer event, API, and pricing views", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "developer" },
		});
		expect(screen.getByText("Event log content")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "API Reference" }));
		expect(screen.getByText("API reference content")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "Pricing" }));
		expect(screen.getByText("Pricing catalog content")).toBeTruthy();
	});

	it("supports roving keyboard navigation across Developer tabs", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "developer" },
		});

		const selectedTab = () =>
			screen.getByRole("tab", { selected: true }) as HTMLButtonElement;
		const eventLog = screen.getByRole("tab", {
			name: "Event Log",
		}) as HTMLButtonElement;
		const api = screen.getByRole("tab", {
			name: "API Reference",
		}) as HTMLButtonElement;
		const pricing = screen.getByRole("tab", {
			name: "Pricing",
		}) as HTMLButtonElement;
		expect(eventLog.tabIndex).toBe(0);
		expect(api.tabIndex).toBe(-1);
		expect(pricing.tabIndex).toBe(-1);

		eventLog.focus();
		fireEvent.keyDown(eventLog, { key: "ArrowLeft" });
		expect(selectedTab()).toBe(pricing);
		expect(document.activeElement).toBe(pricing);
		expect(pricing.tabIndex).toBe(0);

		fireEvent.keyDown(pricing, { key: "ArrowRight" });
		expect(selectedTab()).toBe(eventLog);
		expect(document.activeElement).toBe(eventLog);

		fireEvent.keyDown(eventLog, { key: "End" });
		expect(selectedTab()).toBe(pricing);
		expect(document.activeElement).toBe(pricing);

		fireEvent.keyDown(pricing, { key: "Home" });
		expect(selectedTab()).toBe(eventLog);
		expect(document.activeElement).toBe(eventLog);
	});

	it("keeps nested entry buttons touch sized without losing desktop compactness", () => {
		renderSettings();
		const selector = screen.getByRole("combobox", { name: "Forge category" });
		fireEvent.change(selector, { target: { value: "integrations" } });
		for (const name of [
			"Open Apps",
			"Open Ollama",
			"Open Umbod",
			"Open integrations",
		]) {
			const button = screen.getByRole("button", { name });
			expect(button.className).toContain("min-h-11");
			expect(button.className).toContain("lg:min-h-0");
		}

		fireEvent.change(selector, { target: { value: "experience" } });
		const themeButton = screen.getByRole("button", {
			name: "Open theme editor",
		});
		expect(themeButton.className).toContain("min-h-11");
		expect(themeButton.className).toContain("lg:min-h-0");
	});

	it("opens the custom theme editor as an Experience subpage", () => {
		renderSettings();
		fireEvent.change(screen.getByRole("combobox", { name: "Forge category" }), {
			target: { value: "experience" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Open theme editor" }));
		expect(screen.getByRole("heading", { name: "Custom Theme" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "desktop" })).toBeTruthy();
		expect(screen.getByLabelText("Background color")).toBeTruthy();
		for (const label of [
			"Charts and heatmap color",
			"Tool errors color",
			"Token input color",
			"Token output color",
			"Cache read color",
			"Cache write color",
		]) {
			expect(screen.getByLabelText(label)).toBeTruthy();
		}
		fireEvent.click(screen.getByRole("button", { name: "← Experience" }));
		expect(screen.getByRole("heading", { name: "Experience" })).toBeTruthy();
	});
});
