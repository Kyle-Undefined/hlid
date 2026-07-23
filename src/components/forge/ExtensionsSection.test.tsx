// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInventory } from "#/server/extensionInventory";
import { ExtensionsSection } from "./ExtensionsSection";

const mocks = vi.hoisted(() => ({
	getExtensionInventory: vi.fn(),
	getExtensionReview: vi.fn(),
	mutateExtension: vi.fn(),
}));
vi.mock("#/lib/serverFns/extensions", () => ({
	getExtensionInventoryFn: () => mocks.getExtensionInventory(),
	getExtensionReviewFn: ({ data }: { data: { id: string } }) =>
		mocks.getExtensionReview(data),
	mutateExtensionFn: ({ data }: { data: Record<string, unknown> }) =>
		mocks.mutateExtension(data),
}));

const inventory: ExtensionInventory = {
	generatedAt: "2026-07-22T00:00:00.000Z",
	environments: [
		{
			id: "111111111111111111111111",
			providerId: "claude",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
		},
		{
			id: "222222222222222222222222",
			providerId: "codex",
			environment: "windows",
			environmentLabel: "Windows",
		},
	],
	extensions: [
		{
			id: "claude-extension",
			providerId: "claude",
			providerLabel: "Claude",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			pluginId: "reviewer@official",
			name: "reviewer",
			displayName: "Reviewer",
			marketplace: "official",
			version: "1.2.3",
			description: "Reviews changes",
			author: "Example",
			homepage: "",
			repository: "",
			license: "MIT",
			scope: "user",
			enabled: true,
			installPath: "\\\\wsl$\\Ubuntu\\home\\test\\.claude\\plugins\\reviewer",
			source: "official",
			installedAt: "",
			lastUpdated: "",
			capabilities: ["Write"],
			components: [],
			skillFiles: [],
			manifestPath: "/plugin.json",
			manifestText: '{\n  "name": "reviewer"\n}',
			errors: [],
		},
		{
			id: "codex-extension",
			providerId: "codex",
			providerLabel: "Codex",
			environment: "windows",
			environmentLabel: "Windows",
			pluginId: "github@curated",
			name: "github",
			displayName: "GitHub",
			marketplace: "curated",
			version: "0.4.0",
			description: "GitHub workflows",
			author: "OpenAI",
			homepage: "",
			repository: "",
			license: "",
			scope: "user",
			enabled: false,
			installPath: "C:\\Users\\test\\.codex\\plugins\\github",
			source: "curated",
			installedAt: "",
			lastUpdated: "",
			capabilities: [],
			components: [],
			skillFiles: [],
			manifestPath: "C:\\plugin.json",
			manifestText: '{\n  "name": "github"\n}',
			errors: [],
		},
	],
	marketplaces: [
		{
			id: "333333333333333333333333",
			providerId: "claude",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			name: "official",
			source: "github · example/plugins",
			path: "/marketplace",
			pluginCount: 12,
			lastUpdated: "",
			canManage: true,
		},
	],
	available: [
		{
			id: "0123456789abcdef01234567",
			providerId: "claude",
			providerLabel: "Claude",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			pluginId: "reviewer@official",
			name: "reviewer",
			displayName: "Reviewer",
			marketplace: "official",
			version: "1.2.3",
			description: "Reviews changes",
			author: "Example",
			category: "Development",
			source: "./plugins/reviewer",
			homepage: "",
			installed: false,
			enabled: null,
			reviewLevel: "package",
		},
		{
			id: "abcdef0123456789abcdef01",
			providerId: "claude",
			providerLabel: "Claude",
			environment: "wsl",
			environmentLabel: "WSL · Ubuntu",
			pluginId: "remote@official",
			name: "remote",
			displayName: "Remote helper",
			marketplace: "official",
			version: "",
			description: "Remote metadata",
			author: "",
			category: "Productivity",
			source: "url · https://example.invalid/plugin",
			homepage: "",
			installed: false,
			enabled: null,
			reviewLevel: "marketplace",
		},
	],
	errors: [],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("ExtensionsSection", () => {
	it("shows provider-specific inventories and folded manifest review", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.getExtensionReview.mockResolvedValue({
			...inventory.available[0],
			id: "claude-extension",
			installed: true,
			enabled: true,
			reviewMessage:
				"Complete package review from the provider's installed plugin cache.",
			reviewToken: "f".repeat(64),
			manifestPath: "/plugin.json",
			manifestText: '{"name":"reviewer"}',
			capabilities: ["Write"],
			components: [
				{ kind: "hooks", label: "Hooks", count: 1, names: ["PreToolUse"] },
			],
			skillFiles: [
				{
					path: "skills/review/SKILL.md",
					content: "# Review\n\nReview changes carefully.",
					truncated: false,
				},
			],
			errors: [],
		});
		render(<ExtensionsSection />);

		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		expect(screen.getByText("WSL · Ubuntu")).toBeTruthy();
		expect(screen.getByText("12 available")).toBeTruthy();
		expect(screen.queryByText("skills/review/SKILL.md")).toBeNull();
		fireEvent.click(screen.getByText("Reviewer"));
		expect(await screen.findByText("skills/review/SKILL.md")).toBeTruthy();
		expect(mocks.getExtensionReview).toHaveBeenCalledWith({
			id: "claude-extension",
		});
		expect(screen.queryByText("GitHub")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		expect(screen.getByText("GitHub")).toBeTruthy();
		expect(screen.getByText("Windows")).toBeTruthy();
		expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
		expect(screen.getByText("Complete manifest")).toBeTruthy();
	});

	it("browses cached marketplace entries and lazily reviews one package", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "install",
				providerId: "claude",
				pluginId: "reviewer@official",
				environmentLabel: "WSL · Ubuntu",
				output: "installed",
			},
		});
		mocks.getExtensionReview.mockResolvedValue({
			...inventory.available[0],
			reviewMessage:
				"Complete package review from the provider's local marketplace cache.",
			reviewToken: "f".repeat(64),
			manifestPath: "/marketplace/reviewer/.claude-plugin/plugin.json",
			manifestText: '{"name":"reviewer"}',
			capabilities: ["Write"],
			components: [
				{ kind: "hooks", label: "Hooks", count: 1, names: ["PreToolUse"] },
			],
			skillFiles: [
				{
					path: "skills/review/SKILL.md",
					content: "# Review\n\nReview changes carefully.",
					truncated: false,
				},
			],
			errors: [],
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		expect(screen.getByText("Remote helper")).toBeTruthy();
		expect(screen.getByLabelText("Marketplace environment")).toBeTruthy();
		expect(screen.getByLabelText("Marketplace category")).toBeTruthy();
		expect(screen.queryByText("Complete package review")).toBeNull();

		fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]);
		await waitFor(() =>
			expect(screen.getByText("Complete package review")).toBeTruthy(),
		);
		expect(mocks.getExtensionReview).toHaveBeenCalledWith({
			id: "0123456789abcdef01234567",
		});
		expect(screen.getByText("Hooks · 1")).toBeTruthy();
		fireEvent.click(screen.getByText("skills/review/SKILL.md"));
		expect(screen.getByText(/Review changes carefully/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "install" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "install",
				id: "0123456789abcdef01234567",
				reviewToken: "f".repeat(64),
			}),
		);
		expect(
			await screen.findByText("reviewer@official installed in WSL · Ubuntu."),
		).toBeTruthy();
	});

	it("requires confirmation before uninstalling an exact installed version", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "uninstall",
				providerId: "claude",
				pluginId: "reviewer@official",
				environmentLabel: "WSL · Ubuntu",
				output: "removed",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByText("Reviewer"));
		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		fireEvent.click(screen.getByRole("button", { name: "remove" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "uninstall",
				id: "claude-extension",
				expectedVersion: "1.2.3",
			}),
		);
	});

	it("updates installed Claude plugins without offering a fake Codex update", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "update",
				providerId: "claude",
				subject: "reviewer@official",
				pluginId: "reviewer@official",
				environmentLabel: "WSL · Ubuntu",
				output: "updated",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByText("Reviewer"));
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		fireEvent.click(screen.getByRole("button", { name: "update" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "update",
				id: "claude-extension",
				expectedVersion: "1.2.3",
			}),
		);

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(await screen.findByText("GitHub"));
		expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
	});

	it("keeps card actions aligned and toggles installed plugin status", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		mocks.getExtensionInventory
			.mockResolvedValueOnce(inventory)
			.mockResolvedValueOnce({
				...inventory,
				extensions: inventory.extensions.map((extension) =>
					extension.id === "claude-extension"
						? { ...extension, enabled: false }
						: extension,
				),
			});
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "set_enabled",
				providerId: "claude",
				subject: "reviewer@official",
				pluginId: "reviewer@official",
				environmentLabel: "WSL · Ubuntu",
				output: "disabled",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		const installedDescription = screen.getByText("Reviews changes");
		expect(
			installedDescription.parentElement?.parentElement?.className.includes(
				"sm:grid-cols",
			),
		).toBe(true);
		fireEvent.click(screen.getByText("Reviewer"));
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "set_enabled",
				id: "claude-extension",
				expectedVersion: "1.2.3",
				expectedEnabled: true,
				enabled: false,
			}),
		);
		expect(
			await screen.findByText("reviewer@official disabled in WSL · Ubuntu."),
		).toBeTruthy();
		const dismissal = setTimeoutSpy.mock.calls.find(
			([, milliseconds]) => milliseconds === 5_000,
		)?.[0];
		expect(dismissal).toBeTypeOf("function");
		act(() => {
			if (typeof dismissal === "function") dismissal();
		});
		expect(
			screen.queryByText("reviewer@official disabled in WSL · Ubuntu."),
		).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		const marketplaceDescription = screen.getByText("Reviews changes");
		expect(
			marketplaceDescription.parentElement?.parentElement?.className.includes(
				"sm:grid-cols",
			),
		).toBe(true);
	});

	it("warns before metadata-only install and keeps the marketplace context", async () => {
		const remoteInstalled = {
			...inventory.extensions[0],
			id: "remote-installed",
			pluginId: "remote@official",
			name: "remote",
			displayName: "Remote helper",
			description: "Downloaded package",
			manifestPath: "/plugins/remote/.claude-plugin/plugin.json",
			manifestText: '{"name":"remote"}',
			skillFiles: [
				{
					path: "skills/remote/SKILL.md",
					content: "# Remote installed skill",
					truncated: false,
				},
			],
		};
		mocks.getExtensionInventory
			.mockResolvedValueOnce(inventory)
			.mockResolvedValueOnce({
				...inventory,
				extensions: [...inventory.extensions, remoteInstalled],
				available: inventory.available.map((extension) =>
					extension.id === "abcdef0123456789abcdef01"
						? { ...extension, installed: true, enabled: true }
						: extension,
				),
			});
		mocks.getExtensionReview.mockResolvedValue({
			...inventory.available[1],
			reviewMessage:
				"Marketplace metadata only. The package files are not present locally.",
			reviewToken: "e".repeat(64),
			manifestPath: "/marketplace.json · plugins[remote]",
			manifestText: '{"name":"remote"}',
			capabilities: [],
			components: [],
			skillFiles: [],
			errors: [],
		});
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "install",
				providerId: "claude",
				pluginId: "remote@official",
				environmentLabel: "WSL · Ubuntu",
				output: "installed",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));

		fireEvent.click(screen.getAllByRole("button", { name: "Review" })[1]);
		await waitFor(() =>
			expect(screen.getByText("Marketplace metadata only")).toBeTruthy(),
		);
		expect(
			screen.getByText("The package files have not been reviewed."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "install anyway" }));

		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "install",
				id: "abcdef0123456789abcdef01",
				reviewToken: "e".repeat(64),
			}),
		);
		await waitFor(() =>
			expect(
				screen
					.getByRole("tab", { name: "marketplace" })
					.getAttribute("aria-selected"),
			).toBe("true"),
		);
		expect(
			await screen.findByText("remote@official installed in WSL · Ubuntu."),
		).toBeTruthy();
		expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
		expect(screen.queryByText("skills/remote/SKILL.md")).toBeNull();
	});

	it("adds, refreshes, and removes marketplace sources with explicit confirmation", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockImplementation(
			(input: Record<string, string>) => ({
				ok: true,
				result: {
					action: input.action,
					providerId: "claude",
					subject:
						input.action === "add_marketplace" ? "team-tools" : "official",
					environmentLabel: "WSL · Ubuntu",
					output: "ok",
				},
			}),
		);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));

		fireEvent.click(screen.getByText("Add marketplace source"));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "example/team-tools" },
		});
		fireEvent.change(screen.getByLabelText("Marketplace sparse paths"), {
			target: { value: ".claude-plugin, plugins" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		expect(
			screen
				.getByText(/add marketplace source example\/team-tools/i)
				.className.includes("break-all"),
		).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "add source" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "add_marketplace",
				providerId: "claude",
				environmentId: "111111111111111111111111",
				source: "example/team-tools",
				sparse: [".claude-plugin", "plugins"],
			}),
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Update official" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "update" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "upgrade_marketplace",
				id: "333333333333333333333333",
				expectedSource: "github · example/plugins",
			}),
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Remove official" }),
		);
		expect(screen.getByText(/all Claude settings scopes/)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Update official" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "remove source" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "remove_marketplace",
				id: "333333333333333333333333",
				expectedSource: "github · example/plugins",
			}),
		);
	});
});
