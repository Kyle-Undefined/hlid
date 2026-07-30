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
import type {
	ExtensionInventory,
	ExtensionReview,
} from "#/server/extensionInventory";
import { ExtensionsSection } from "./ExtensionsSection";
import { useExtensionSectionController } from "./useExtensionSectionController";

const mocks = vi.hoisted(() => ({
	getExtensionInventory: vi.fn(),
	refreshExtensionInventory: vi.fn(),
	getExtensionReview: vi.fn(),
	mutateExtension: vi.fn(),
}));
vi.mock("#/lib/serverFns/extensions", () => ({
	getExtensionInventoryFn: () => mocks.getExtensionInventory(),
	refreshExtensionInventoryFn: () => mocks.refreshExtensionInventory(),
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
			nativeUpdate: { available: true },
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
			nativeUpdate: {
				available: false,
				reason: "Codex does not expose a native per-plugin update command.",
			},
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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((fulfill, fail) => {
		resolve = fulfill;
		reject = fail;
	});
	return { promise, reject, resolve };
}

function installedReview(
	message: string,
	manifestText: string,
	skillPath: string,
): ExtensionReview {
	return {
		...inventory.available[0],
		id: "claude-extension",
		installed: true,
		enabled: true,
		reviewMessage: message,
		reviewToken: "f".repeat(64),
		manifestPath: "/plugin.json",
		manifestText,
		capabilities: [],
		components: [],
		skillFiles: [
			{
				path: skillPath,
				content: `# ${message}`,
				truncated: false,
			},
		],
		errors: [],
	};
}

function ExtensionControllerHarness() {
	const controller = useExtensionSectionController();
	return (
		<>
			<div data-testid="inventory-generation">
				{controller.inventory.generatedAt}
			</div>
			<button type="button" onClick={() => void controller.load()}>
				Load inventory
			</button>
		</>
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("ExtensionsSection", () => {
	it("keeps the newest inventory when an older request resolves last", async () => {
		const olderRequest = deferred<ExtensionInventory>();
		const newerRequest = deferred<ExtensionInventory>();
		mocks.getExtensionInventory
			.mockResolvedValueOnce(inventory)
			.mockImplementationOnce(() => olderRequest.promise)
			.mockImplementationOnce(() => newerRequest.promise);
		render(<ExtensionControllerHarness />);
		await waitFor(() =>
			expect(screen.getByTestId("inventory-generation").textContent).toBe(
				inventory.generatedAt,
			),
		);

		const loadButton = screen.getByRole("button", { name: "Load inventory" });
		fireEvent.click(loadButton);
		fireEvent.click(loadButton);
		expect(mocks.getExtensionInventory).toHaveBeenCalledTimes(3);

		await act(async () => {
			newerRequest.resolve({
				...inventory,
				generatedAt: "2026-07-22T00:02:00.000Z",
			});
			await newerRequest.promise;
		});
		expect(screen.getByTestId("inventory-generation").textContent).toBe(
			"2026-07-22T00:02:00.000Z",
		);

		await act(async () => {
			olderRequest.resolve({
				...inventory,
				generatedAt: "2026-07-22T00:01:00.000Z",
			});
			await olderRequest.promise;
		});
		expect(screen.getByTestId("inventory-generation").textContent).toBe(
			"2026-07-22T00:02:00.000Z",
		);
	});

	it("keeps the newest marketplace review when the prior request resolves last", async () => {
		const firstReview = deferred<ExtensionReview>();
		const secondReview = deferred<ExtensionReview>();
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.getExtensionReview.mockImplementation(({ id }: { id: string }) =>
			id === inventory.available[0]?.id
				? firstReview.promise
				: secondReview.promise,
		);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));

		const reviewButtons = screen.getAllByRole("button", { name: "Review" });
		fireEvent.click(reviewButtons[0]);
		fireEvent.click(reviewButtons[1]);

		await act(async () => {
			secondReview.resolve({
				...inventory.available[1],
				reviewMessage: "The second review remains selected.",
				reviewToken: "b".repeat(64),
				manifestPath: "/marketplace.json",
				manifestText: '{"name":"remote"}',
				capabilities: [],
				components: [],
				skillFiles: [],
				errors: [],
			});
			await secondReview.promise;
		});
		expect(
			screen.getByText("The second review remains selected."),
		).toBeTruthy();

		await act(async () => {
			firstReview.resolve({
				...inventory.available[0],
				reviewMessage: "The stale first review replaced the selection.",
				reviewToken: "a".repeat(64),
				manifestPath: "/plugin.json",
				manifestText: '{"name":"reviewer"}',
				capabilities: [],
				components: [],
				skillFiles: [],
				errors: [],
			});
			await firstReview.promise;
		});
		expect(
			screen.getByText("The second review remains selected."),
		).toBeTruthy();
		expect(
			screen.queryByText("The stale first review replaced the selection."),
		).toBeNull();
	});

	it("refuses inventory and mutation follow-up work after unmount", async () => {
		const mutation = deferred<{
			ok: true;
			result: {
				action: "set_enabled";
				providerId: "claude";
				subject: string;
				pluginId: string;
				environmentLabel: string;
				output: string;
			};
		}>();
		const onSuccess = vi.fn();
		const controllerRef: {
			current: ReturnType<typeof useExtensionSectionController> | null;
		} = { current: null };
		function LifecycleHarness() {
			const controller = useExtensionSectionController();
			controllerRef.current = controller;
			return (
				<button
					type="button"
					onClick={() =>
						void controller?.mutation.mutate(
							{
								action: "set_enabled",
								id: "claude-extension",
								expectedVersion: "1.2.3",
								expectedEnabled: true,
								enabled: false,
							},
							onSuccess,
						)
					}
				>
					Mutate extension
				</button>
			);
		}
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockImplementation(() => mutation.promise);
		const view = render(<LifecycleHarness />);
		await waitFor(() =>
			expect(mocks.getExtensionInventory).toHaveBeenCalledOnce(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Mutate extension" }));
		expect(mocks.mutateExtension).toHaveBeenCalledOnce();

		view.unmount();
		await controllerRef.current?.load();
		await controllerRef.current?.retryInspection();
		expect(mocks.getExtensionInventory).toHaveBeenCalledOnce();
		expect(mocks.refreshExtensionInventory).not.toHaveBeenCalled();

		await act(async () => {
			mutation.resolve({
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
			await mutation.promise;
		});
		expect(onSuccess).not.toHaveBeenCalled();
		expect(mocks.getExtensionInventory).toHaveBeenCalledOnce();
		expect(mocks.refreshExtensionInventory).not.toHaveBeenCalled();
	});

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

	it("reloads an open installed review when refreshed package bodies change", async () => {
		const refreshedReview = deferred<ExtensionReview>();
		const updatedInventory: ExtensionInventory = {
			...inventory,
			generatedAt: "2026-07-22T00:04:00.000Z",
		};
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.refreshExtensionInventory.mockResolvedValue(updatedInventory);
		mocks.getExtensionReview
			.mockResolvedValueOnce(
				installedReview(
					"Stale package review",
					'{"name":"reviewer"}',
					"skills/stale/SKILL.md",
				),
			)
			.mockImplementationOnce(() => refreshedReview.promise);
		render(<ExtensionsSection />);
		fireEvent.click(await screen.findByText("Reviewer"));
		expect(await screen.findByText("skills/stale/SKILL.md")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		expect(await screen.findByText("Loading package files…")).toBeTruthy();
		expect(screen.queryByText("skills/stale/SKILL.md")).toBeNull();
		expect(mocks.getExtensionReview).toHaveBeenCalledTimes(2);

		await act(async () => {
			refreshedReview.resolve(
				installedReview(
					"Current package review",
					'{"name":"reviewer"}',
					"skills/current/SKILL.md",
				),
			);
			await refreshedReview.promise;
		});
		expect(await screen.findByText("skills/current/SKILL.md")).toBeTruthy();
		expect(mocks.getExtensionReview).toHaveBeenCalledTimes(2);
	});

	it("owns pending installed reviews across an A to B to A revision cycle", async () => {
		const firstAReview = deferred<ExtensionReview>();
		const bReview = deferred<ExtensionReview>();
		const secondAReview = deferred<ExtensionReview>();
		const updatedInventory: ExtensionInventory = {
			...inventory,
			extensions: inventory.extensions.map((extension) =>
				extension.id === "claude-extension"
					? {
							...extension,
							version: "2.0.0",
							lastUpdated: "2026-07-22T00:03:00.000Z",
							manifestText: '{"name":"reviewer-v2"}',
						}
					: extension,
			),
		};
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.refreshExtensionInventory
			.mockResolvedValueOnce(updatedInventory)
			.mockResolvedValueOnce(inventory);
		mocks.getExtensionReview
			.mockImplementationOnce(() => firstAReview.promise)
			.mockImplementationOnce(() => bReview.promise)
			.mockImplementationOnce(() => secondAReview.promise);
		render(<ExtensionsSection />);
		fireEvent.click(await screen.findByText("Reviewer"));
		expect(await screen.findByText("Loading package files…")).toBeTruthy();
		expect(mocks.getExtensionReview).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("2.0.0")).toBeTruthy();
		expect(screen.getByText('{"name":"reviewer-v2"}')).toBeTruthy();
		await waitFor(() =>
			expect(mocks.getExtensionReview).toHaveBeenCalledTimes(2),
		);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("1.2.3")).toBeTruthy();
		await waitFor(() =>
			expect(mocks.getExtensionReview).toHaveBeenCalledTimes(3),
		);

		await act(async () => {
			firstAReview.resolve(
				installedReview(
					"First A review",
					'{"name":"reviewer-a-old"}',
					"skills/first-a/SKILL.md",
				),
			);
			await firstAReview.promise;
		});
		expect(screen.queryByText("skills/first-a/SKILL.md")).toBeNull();
		expect(screen.getByText("Loading package files…")).toBeTruthy();
		await act(async () => {
			bReview.resolve(
				installedReview(
					"B review",
					'{"name":"reviewer-b"}',
					"skills/b/SKILL.md",
				),
			);
			await bReview.promise;
		});
		expect(screen.queryByText("skills/b/SKILL.md")).toBeNull();
		expect(screen.getByText("Loading package files…")).toBeTruthy();
		await act(async () => {
			secondAReview.resolve(
				installedReview(
					"Current A review",
					'{"name":"reviewer"}',
					"skills/current-a/SKILL.md",
				),
			);
			await secondAReview.promise;
		});
		expect(await screen.findByText("skills/current-a/SKILL.md")).toBeTruthy();
		expect(screen.queryByText("Loading package files…")).toBeNull();
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

	it("offers provider-native cache recovery without inventing a Codex update", async () => {
		const recoveryInventory: ExtensionInventory = {
			...inventory,
			extensions: inventory.extensions.map((extension) =>
				extension.providerId === "claude"
					? {
							...extension,
							errors: ["Manifest JSON is invalid: unexpected token"],
							cacheRecovery: {
								issue: "corrupt" as const,
								action: "native_update" as const,
							},
							reviewHealth: "damaged" as const,
						}
					: {
							...extension,
							errors: ["Plugin manifest is missing"],
							cacheRecovery: {
								issue: "missing" as const,
								action: "marketplace_refresh_reinstall" as const,
							},
							reviewHealth: "damaged" as const,
						},
			),
		};
		mocks.getExtensionInventory.mockResolvedValue(recoveryInventory);
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "update",
				providerId: "claude",
				subject: "reviewer@official",
				pluginId: "reviewer@official",
				environmentLabel: "WSL · Ubuntu",
				output: "repaired",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByText("Reviewer"));
		expect(
			screen.getByText(/Ask Claude to repair it through its native plugin/),
		).toBeTruthy();
		expect(screen.getByText("Manifest unavailable")).toBeTruthy();
		expect(screen.queryByText("Complete manifest")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Repair cache" }));
		fireEvent.click(screen.getByRole("button", { name: "repair" }));
		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "update",
				id: "claude-extension",
				expectedVersion: "1.2.3",
			}),
		);

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(await screen.findByText("GitHub"));
		expect(
			screen.getByText(
				"Codex does not expose a native per-plugin update command.",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				/Refresh the curated marketplace source, then uninstall this package/,
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Repair cache" })).toBeNull();
	});

	it("does not recommend removing a damaged Codex package without a proven replacement", async () => {
		mocks.getExtensionInventory.mockResolvedValue({
			...inventory,
			extensions: inventory.extensions.map((extension) =>
				extension.providerId === "codex"
					? {
							...extension,
							errors: ["Plugin manifest is missing"],
							cacheRecovery: {
								issue: "missing" as const,
								action: "restore_source" as const,
							},
							reviewHealth: "damaged" as const,
						}
					: extension,
			),
		});
		render(<ExtensionsSection />);

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(await screen.findByText("GitHub"));
		expect(
			screen.getByText(/cannot prove that a manageable source/),
		).toBeTruthy();
		expect(
			screen.getByText(/review the replacement before removing/),
		).toBeTruthy();
		expect(
			screen.queryByText(
				/Refresh the curated marketplace source, then uninstall this package/,
			),
		).toBeNull();
	});

	it("labels provider-native marketplace recovery from explicit health", async () => {
		const configuredMarketplace = inventory.marketplaces[0];
		if (!configuredMarketplace)
			throw new Error("Marketplace fixture is missing");
		mocks.getExtensionInventory.mockResolvedValue({
			...inventory,
			marketplaces: [
				{
					...configuredMarketplace,
					health: "missing",
					diagnostic: "The local snapshot is missing.",
				},
				{
					...configuredMarketplace,
					id: "444444444444444444444444",
					name: "broken",
					health: "invalid",
					diagnostic: "The local snapshot is invalid.",
				},
				{
					...configuredMarketplace,
					id: "555555555555555555555555",
					name: "read-only",
					canManage: false,
					health: "missing",
					diagnostic: "The read-only built-in marketplace snapshot is missing.",
				},
				{
					...configuredMarketplace,
					id: "666666666666666666666666",
					name: "offline",
					health: "unavailable",
					diagnostic: "Hlið could not inspect this snapshot. Retry inspection.",
				},
			],
		});
		render(<ExtensionsSection />);

		expect(
			await screen.findByRole("button", { name: "Refresh source official" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Repair source broken" }),
		).toBeTruthy();
		expect(screen.getByText("The local snapshot is missing.")).toBeTruthy();
		expect(screen.getByText("The local snapshot is invalid.")).toBeTruthy();
		expect(
			screen.getByText(
				"The read-only built-in marketplace snapshot is missing.",
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Refresh source read-only" }),
		).toBeNull();
		expect(
			screen.getByText(
				"Hlið could not inspect this snapshot. Retry inspection.",
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Refresh source offline" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Repair source offline" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Remove offline" })).toBeTruthy();
	});

	it("forces a fresh inventory scan from the visible toolbar refresh", async () => {
		mocks.getExtensionInventory.mockResolvedValueOnce(inventory);
		mocks.refreshExtensionInventory.mockResolvedValueOnce(inventory);
		render(<ExtensionsSection />);

		fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

		await waitFor(() =>
			expect(mocks.refreshExtensionInventory).toHaveBeenCalledOnce(),
		);
		expect(mocks.getExtensionInventory).toHaveBeenCalledOnce();
		expect(mocks.mutateExtension).not.toHaveBeenCalled();
	});

	it("retries an offline marketplace inspection without mutating provider state", async () => {
		const offlineInventory: ExtensionInventory = {
			...inventory,
			errors: [
				{
					providerId: "codex",
					environment: "windows",
					environmentLabel: "Windows",
					message: "Marketplace lookup failed: network is unreachable",
					recovery: "retry_inventory",
				},
			],
		};
		mocks.getExtensionInventory.mockResolvedValueOnce(offlineInventory);
		mocks.refreshExtensionInventory.mockResolvedValueOnce(inventory);
		render(<ExtensionsSection />);

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Retry inspection" }),
		);
		await waitFor(() =>
			expect(mocks.refreshExtensionInventory).toHaveBeenCalledOnce(),
		);
		expect(mocks.getExtensionInventory).toHaveBeenCalledOnce();
		expect(mocks.mutateExtension).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Retry inspection" }),
		).toBeNull();
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
			await screen.findByRole("button", { name: "Refresh source official" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "refresh source" }));
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
			screen.queryByRole("button", { name: "Refresh source official" }),
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

	it("keeps independent mutation owners and their feedback visible", async () => {
		const claudeMutation = deferred<{
			ok: true;
			result: {
				action: "set_enabled";
				providerId: "claude";
				subject: string;
				pluginId: string;
				environmentLabel: string;
				output: string;
			};
		}>();
		const codexMutation = deferred<never>();
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.getExtensionReview.mockResolvedValue(null);
		mocks.mutateExtension.mockImplementation(
			(input: Record<string, unknown>) =>
				input.id === "claude-extension"
					? claudeMutation.promise
					: codexMutation.promise,
		);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByText("Reviewer"));
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy(),
		);
		expect(
			screen.getByRole("button", { name: "Update" }).hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "Uninstall" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
		).toBe(true);

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(await screen.findByText("GitHub"));
		const enable = screen.getByRole("button", { name: "Enable" });
		expect(enable.hasAttribute("disabled")).toBe(false);
		fireEvent.click(enable);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy(),
		);

		await act(async () => {
			claudeMutation.resolve({
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
			await claudeMutation.promise;
		});
		expect((await screen.findByRole("status")).textContent).toContain(
			"reviewer@official disabled in WSL · Ubuntu.",
		);
		expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();

		await act(async () => {
			codexMutation.reject(new Error("Codex enable failed"));
			await codexMutation.promise.catch(() => {});
		});
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Codex enable failed",
		);
		expect(screen.getByRole("status").textContent).toContain(
			"reviewer@official disabled in WSL · Ubuntu.",
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Dismiss extension action error",
			}),
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain(
			"reviewer@official disabled in WSL · Ubuntu.",
		);
	});

	it("keeps inspection controls disabled through mutation reconciliation", async () => {
		const reconciliation = deferred<ExtensionInventory>();
		const inventoryWithRetry: ExtensionInventory = {
			...inventory,
			errors: [
				{
					providerId: "claude",
					environment: "wsl",
					environmentLabel: "WSL · Ubuntu",
					message: "Marketplace inspection is temporarily unavailable",
					recovery: "retry_inventory",
				},
			],
		};
		mocks.getExtensionInventory
			.mockResolvedValueOnce(inventoryWithRetry)
			.mockImplementationOnce(() => reconciliation.promise);
		mocks.getExtensionReview.mockResolvedValue(null);
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
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Retry inspection" }),
			).toBeTruthy(),
		);

		fireEvent.click(screen.getByText("Reviewer"));
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(mocks.getExtensionInventory).toHaveBeenCalledTimes(2),
		);
		expect(
			screen
				.getByRole("button", { name: "Inspecting…" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen
				.getByRole("button", { name: "Retrying…" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(screen.getByRole("button", { name: "Working…" })).toBeTruthy();

		await act(async () => {
			reconciliation.resolve(inventoryWithRetry);
			await reconciliation.promise;
		});
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Disable" })
					.hasAttribute("disabled"),
			).toBe(false),
		);
		expect(
			screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
		).toBe(false);
		expect(
			screen
				.getByRole("button", { name: "Retry inspection" })
				.hasAttribute("disabled"),
		).toBe(false);
	});

	it("shows progress only for the marketplace action that owns the card", async () => {
		const marketplaceMutation = deferred<{
			ok: true;
			result: {
				action: "upgrade_marketplace";
				providerId: "claude";
				subject: string;
				environmentLabel: string;
				output: string;
			};
		}>();
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockImplementation(() => marketplaceMutation.promise);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh source official" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "refresh source" }));
		await waitFor(() => expect(mocks.mutateExtension).toHaveBeenCalledOnce());
		const refresh = screen.getByRole("button", {
			name: "Refresh source official",
		});
		const remove = screen.getByRole("button", { name: "Remove official" });
		expect(refresh.textContent).toBe("Working…");
		expect(refresh.hasAttribute("disabled")).toBe(true);
		expect(remove.textContent).toBe("Remove");
		expect(remove.hasAttribute("disabled")).toBe(true);

		await act(async () => {
			marketplaceMutation.resolve({
				ok: true,
				result: {
					action: "upgrade_marketplace",
					providerId: "claude",
					subject: "official",
					environmentLabel: "WSL · Ubuntu",
					output: "updated",
				},
			});
			await marketplaceMutation.promise;
		});
		await waitFor(() =>
			expect(
				screen
					.getByRole("button", { name: "Refresh source official" })
					.hasAttribute("disabled"),
			).toBe(false),
		);
	});

	it("closes marketplace confirmation when its draft context changes", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		fireEvent.click(screen.getByText("Add marketplace source"));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "example/first-source" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		expect(screen.getByRole("button", { name: "add source" })).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));

		expect(screen.queryByRole("button", { name: "add source" })).toBeNull();
		expect(screen.getByRole("button", { name: "Add source" })).toBeTruthy();
		expect(mocks.mutateExtension).not.toHaveBeenCalled();
	});

	it("does not clear a marketplace draft changed after submission", async () => {
		const mutation = deferred<{
			ok: true;
			result: {
				action: "add_marketplace";
				providerId: "claude";
				subject: string;
				environmentLabel: string;
				output: string;
			};
		}>();
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockImplementation(() => mutation.promise);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		fireEvent.click(screen.getByText("Add marketplace source"));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "example/first-source" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		fireEvent.click(screen.getByRole("button", { name: "add source" }));
		await waitFor(() => expect(mocks.mutateExtension).toHaveBeenCalledOnce());
		expect(screen.getByRole("button", { name: "Adding…" })).toBeTruthy();

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "example/second-source" },
		});
		fireEvent.change(screen.getByLabelText("Marketplace Git ref"), {
			target: { value: "release-2" },
		});
		const blockedAdd = screen.getByRole("button", { name: "Add source" });
		expect(blockedAdd.hasAttribute("disabled")).toBe(true);

		await act(async () => {
			mutation.resolve({
				ok: true,
				result: {
					action: "add_marketplace",
					providerId: "claude",
					subject: "first-source",
					environmentLabel: "WSL · Ubuntu",
					output: "added",
				},
			});
			await mutation.promise;
		});
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Marketplace source") as HTMLInputElement).value,
			).toBe("example/second-source"),
		);
		expect(
			(screen.getByLabelText("Marketplace Git ref") as HTMLInputElement).value,
		).toBe("release-2");
	});

	it("keeps an unfinished marketplace draft while switching views", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "example/team-tools" },
		});
		fireEvent.change(screen.getByLabelText("Marketplace Git ref"), {
			target: { value: "release-1" },
		});
		fireEvent.change(screen.getByLabelText("Marketplace sparse paths"), {
			target: { value: "plugins/github" },
		});

		fireEvent.click(screen.getByRole("tab", { name: "installed" }));
		expect(screen.queryByLabelText("Marketplace source")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));

		expect(
			(screen.getByLabelText("Marketplace source") as HTMLInputElement).value,
		).toBe("example/team-tools");
		expect(
			(screen.getByLabelText("Marketplace Git ref") as HTMLInputElement).value,
		).toBe("release-1");
		expect(
			(screen.getByLabelText("Marketplace sparse paths") as HTMLInputElement)
				.value,
		).toBe("plugins/github");
	});

	it("refreshes inventory and releases the action after a native mutation failure", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockRejectedValue(
			new Error("Native plugin command failed"),
		);
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

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
			await screen.findByText("Native plugin command failed"),
		).toBeTruthy();
		await waitFor(() =>
			expect(mocks.getExtensionInventory).toHaveBeenCalledTimes(2),
		);
		expect(
			screen.getByRole("button", { name: "Disable" }).hasAttribute("disabled"),
		).toBe(false);
	});

	it("keeps the Codex marketplace source payload native and clears it after success", async () => {
		mocks.getExtensionInventory.mockResolvedValue(inventory);
		mocks.mutateExtension.mockResolvedValue({
			ok: true,
			result: {
				action: "add_marketplace",
				providerId: "codex",
				subject: "example/team-tools",
				environmentLabel: "Windows",
				output: "added",
			},
		});
		render(<ExtensionsSection />);
		await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());

		fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
		fireEvent.click(screen.getByRole("tab", { name: "marketplace" }));
		fireEvent.click(screen.getByText("Add marketplace source"));
		fireEvent.change(screen.getByLabelText("Marketplace source"), {
			target: { value: "  example/team-tools  " },
		});
		fireEvent.change(screen.getByLabelText("Marketplace Git ref"), {
			target: { value: "  release-1  " },
		});
		fireEvent.change(screen.getByLabelText("Marketplace sparse paths"), {
			target: { value: "plugins/github,\nplugins/issues" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add source" }));
		fireEvent.click(screen.getByRole("button", { name: "add source" }));

		await waitFor(() =>
			expect(mocks.mutateExtension).toHaveBeenCalledWith({
				action: "add_marketplace",
				providerId: "codex",
				environmentId: "222222222222222222222222",
				source: "example/team-tools",
				ref: "release-1",
				sparse: ["plugins/github", "plugins/issues"],
			}),
		);
		await waitFor(() =>
			expect(
				(screen.getByLabelText("Marketplace source") as HTMLInputElement).value,
			).toBe(""),
		);
		expect(
			(screen.getByLabelText("Marketplace Git ref") as HTMLInputElement).value,
		).toBe("");
		expect(
			(screen.getByLabelText("Marketplace sparse paths") as HTMLInputElement)
				.value,
		).toBe("");
	});
});
