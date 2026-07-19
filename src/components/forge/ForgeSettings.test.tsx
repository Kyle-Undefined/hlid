// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	AcpSection: () => <div>ACP catalog content</div>,
}));
vi.mock("#/components/forge/ApiSection", () => ({
	ApiSection: () => <div>API reference content</div>,
}));
vi.mock("#/components/forge/AutoSleepSection", () => ({
	AutoSleepSection: () => <div>Auto sleep content</div>,
}));
vi.mock("#/components/forge/ClaudeSection", () => ({
	ClaudeSection: () => <div>Claude content</div>,
	ComputerUseSection: () => <div>Computer Use content</div>,
}));
vi.mock("#/components/forge/EventLogSection", () => ({
	EventLogSection: () => <div>Event log content</div>,
}));
vi.mock("#/components/forge/InstructionFilesSection", () => ({
	InstructionFilesSection: () => <div>Agent Instructions content</div>,
}));
vi.mock("#/components/forge/McpSection", () => ({
	McpSection: () => <div>MCP content</div>,
}));
vi.mock("#/components/forge/NetworkSection", () => ({
	NetworkSection: () => <div>Network content</div>,
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
	VaultSection: () => <div>Vault content</div>,
}));
vi.mock("#/components/forge/VocabSection", () => ({
	VocabSection: () => <div>Vocabulary content</div>,
}));
vi.mock("#/components/forge/VoiceSection", () => ({
	VoiceSection: () => <div>Voice content</div>,
}));

afterEach(cleanup);

describe("ForgeSettings search", () => {
	it("opens the matching category instead of only filtering the sidebar", async () => {
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
		fireEvent.change(
			screen.getByRole("textbox", { name: "Filter setting categories" }),
			{
				target: { value: "shutdown" },
			},
		);

		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "Advanced" })).toBeTruthy(),
		);
		expect(screen.getByText("System section: advanced")).toBeTruthy();
	});

	it("matches section labels rendered inside category pages", async () => {
		renderSettings();
		fireEvent.change(
			screen.getByRole("textbox", { name: "Filter setting categories" }),
			{
				target: { value: "umbod" },
			},
		);

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Integrations" }),
			).toBeTruthy(),
		);
		expect(screen.getByText("Umbod policy")).toBeTruthy();
		expect(screen.getByRole("option", { name: "Integrations" })).toBeTruthy();
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
});

function renderSettings() {
	return render(
		<ForgeSettings
			initial={
				{
					providers: [],
					accountInfo: null,
					acpCatalog: [],
					cwd: "/tmp/vault",
					voiceInfo: null,
				} as never
			}
			state={
				{
					saving: false,
					dirty: false,
					error: null,
					savedMsg: null,
					save: vi.fn(),
					claude: { vaultProvider: "claude" },
					codex: {},
					vault: { path: "/tmp/vault" },
					vocab: {},
					autoSleep: {},
					server: {},
					ui: {
						theme: "tan",
						mobileTheme: "same",
						customTheme: TAN_THEME,
						mobileCustomTheme: TAN_THEME,
					},
					voice: {},
					acpAgents: [],
					umbod: {},
					changeClaude: vi.fn(),
					setVault: vi.fn(),
					setVocab: vi.fn(),
					setAutoSleep: vi.fn(),
					setServer: vi.fn(),
					setUi: vi.fn(),
					setVoice: vi.fn(),
					setAcpAgents: vi.fn(),
					setUmbod: vi.fn(),
				} as never
			}
		/>,
	);
}

describe("ForgeSettings category navigation", () => {
	it("places Computer Use between the Vault agent and Auto Sleep", () => {
		renderSettings();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Filtered Forge category" }),
			{
				target: { value: "agents" },
			},
		);

		const content = document.body.textContent ?? "";
		expect(content.indexOf("Claude content")).toBeLessThan(
			content.indexOf("Computer Use content"),
		);
		expect(content.indexOf("Computer Use content")).toBeLessThan(
			content.indexOf("Auto sleep content"),
		);
	});

	it("renders every top-level category selected from the mobile selector", () => {
		renderSettings();
		const selector = screen.getByRole("combobox", {
			name: "Filtered Forge category",
		});

		for (const category of [
			"Workspace",
			"Agents",
			"Access",
			"Experience",
			"Integrations",
			"Developer",
			"Advanced",
		]) {
			fireEvent.change(selector, { target: { value: category.toLowerCase() } });
			expect(screen.getByRole("heading", { name: category })).toBeTruthy();
		}
	});

	it("opens and returns from the ACP and Umbod integration pages", () => {
		renderSettings();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Filtered Forge category" }),
			{
				target: { value: "integrations" },
			},
		);

		fireEvent.click(screen.getByRole("button", { name: "Open catalog" }));
		expect(
			screen.getByRole("heading", { name: "ACP Agent Catalog" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));

		fireEvent.click(screen.getByRole("button", { name: "Open Umbod" }));
		expect(screen.getByRole("heading", { name: "Umbod" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "← Integrations" }));
		expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
	});

	it("switches between developer event, API, and pricing views", () => {
		renderSettings();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Filtered Forge category" }),
			{
				target: { value: "developer" },
			},
		);
		expect(screen.getByText("Event log content")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "API Reference" }));
		expect(screen.getByText("API reference content")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "Pricing" }));
		expect(screen.getByText("Pricing catalog content")).toBeTruthy();
	});

	it("opens the custom theme editor as an Experience subpage", () => {
		renderSettings();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Filtered Forge category" }),
			{
				target: { value: "experience" },
			},
		);
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
