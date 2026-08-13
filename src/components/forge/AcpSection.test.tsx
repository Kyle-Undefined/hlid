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
import type { HlidConfig } from "#/config";
import type { AcpCatalogItem } from "#/lib/serverFns/acp";
import { AcpSection } from "./AcpSection";

const mutationRevision = "a".repeat(64);

const serverFns = vi.hoisted(() => ({
	authenticate: vi.fn(),
	registry: vi.fn(),
	listSessions: vi.fn(),
	importSession: vi.fn(),
	mutate: vi.fn(),
	refreshUpdates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#/hooks/updateStore", () => ({
	refreshUpdateStatus: serverFns.refreshUpdates,
}));

vi.mock("#/lib/serverFns/acp", () => ({
	authenticateAcpFn: serverFns.authenticate,
	getAcpRegistryFn: serverFns.registry,
	listAcpProviderSessionsFn: serverFns.listSessions,
	importAcpProviderSessionFn: serverFns.importSession,
}));

vi.mock("#/lib/acpManagedClient", () => ({
	mutateAcpManagedInstallation: serverFns.mutate,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

function item(id: string, name: string): AcpCatalogItem {
	return {
		id,
		name,
		version: "1.0.0",
		description: `${name} agent`,
		providerId: `acp:${id}`,
		enabled: true,
		available: true,
		command: id,
		args: [],
		env: {},
		installGuidance: `Install ${name}`,
		targets: [
			{
				targetId: "host",
				target: { kind: "host" },
				label: "Windows",
				recommended: true,
				selected: true,
				platformTarget: "windows-x86_64",
				provenance: "external",
				available: true,
				canEnable: true,
				canInstall: false,
				canUpdate: false,
				canRemove: false,
				registryVersion: "1.0.0",
				mutationRevision,
				command: id,
				args: [],
				installGuidance: `Install ${name}`,
			},
		],
	};
}

function wslTarget(
	patch: Partial<AcpCatalogItem["targets"][number]> = {},
): AcpCatalogItem["targets"][number] {
	return {
		targetId: "wsl-ubuntu",
		target: { kind: "wsl", distro: "Ubuntu-24.04" },
		label: "WSL · Ubuntu-24.04",
		recommended: true,
		selected: true,
		platformTarget: "linux-x86_64",
		provenance: "managed",
		available: true,
		canEnable: true,
		canInstall: false,
		canUpdate: false,
		canRemove: true,
		registryVersion: "1.0.0",
		mutationRevision,
		installedVersion: "1.0.0",
		command: "/managed/opencode",
		args: ["acp"],
		installGuidance: "Install OpenCode",
		...patch,
	};
}

const configured = [{ id: "opencode" }, { id: "pi-acp" }] satisfies NonNullable<
	HlidConfig["acp_agents"]
>;

describe("AcpSection", () => {
	it("allows only one live ACP operation at a time", async () => {
		let finish: ((value: unknown) => void) | undefined;
		serverFns.authenticate.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(
			<AcpSection
				initialCatalog={[
					item("opencode", "OpenCode"),
					item("pi-acp", "Pi ACP"),
				]}
				value={configured}
				onChange={vi.fn()}
				onRefreshProviders={vi.fn()}
			/>,
		);

		const openCodeInspect = screen.getByRole("button", {
			name: "Verify OpenCode ACP",
		});
		const piInspect = screen.getByRole("button", { name: "Inspect agent" });
		fireEvent.click(openCodeInspect);
		expect((piInspect as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(piInspect);
		expect(serverFns.authenticate).toHaveBeenCalledOnce();

		finish?.({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		await waitFor(() =>
			expect(screen.getByText("installed OpenCode 1.2.3")).toBeTruthy(),
		);
	});

	it("browses paged provider-native metadata and imports explicit continuity", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.18.16" },
			canListSessions: true,
		});
		serverFns.listSessions
			.mockResolvedValueOnce({
				sessions: [
					{
						sessionId: "native-1",
						title: "First provider session",
						updatedAt: "2026-08-12T12:00:00.000Z",
					},
				],
				canImportSessions: true,
				nextCursor: "next-page",
			})
			.mockResolvedValueOnce({
				sessions: [
					{
						sessionId: "native-2",
						title: "Second provider session",
					},
				],
				canImportSessions: true,
			});
		serverFns.importSession.mockResolvedValue({
			sessionId: "hlid-import-1",
			created: true,
		});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("installed OpenCode 1.18.16");
		fireEvent.click(
			screen.getByRole("button", { name: "Browse provider sessions" }),
		);

		await screen.findByText("First provider session");
		expect(
			screen.getByText(/These are not Hlid sessions or forks/),
		).toBeTruthy();
		expect(
			screen.getByText(/Earlier transcript remains provider-owned/),
		).toBeTruthy();
		expect(serverFns.listSessions).toHaveBeenNthCalledWith(1, {
			data: { id: "opencode" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Second provider session");
		expect(serverFns.listSessions).toHaveBeenNthCalledWith(2, {
			data: { id: "opencode", cursor: "next-page" },
		});

		const importButtons = screen.getAllByRole("button", {
			name: "Import into Hlid",
		});
		fireEvent.click(importButtons[0] as HTMLButtonElement);
		const ravenLink = await screen.findByRole("link", {
			name: "Open in Raven",
		});
		expect(serverFns.importSession).toHaveBeenCalledWith({
			data: { id: "opencode", providerSessionId: "native-1" },
		});
		expect(ravenLink.getAttribute("href")).toBe("/raven?session=hlid-import-1");
		expect(screen.getByText("Hlid entry created")).toBeTruthy();
	});

	it("does not offer provider session browsing when the capability is absent", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.18.16" },
			canListSessions: false,
		});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("Provider-native session listing not advertised.");
		expect(
			screen.queryByRole("button", { name: "Browse provider sessions" }),
		).toBeNull();
	});

	it("keeps list-only provider sessions metadata-only", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.18.16" },
			canListSessions: true,
			canImportSessions: false,
		});
		serverFns.listSessions.mockResolvedValue({
			sessions: [{ sessionId: "metadata-only", title: "Listed session" }],
			canImportSessions: false,
		});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("installed OpenCode 1.18.16");
		fireEvent.click(
			screen.getByRole("button", { name: "Browse provider sessions" }),
		);

		await screen.findByText("Listed session");
		expect(screen.getByText("Metadata only")).toBeTruthy();
		expect(
			screen.getByText(/does not advertise loading or resuming/),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Import into Hlid" }),
		).toBeNull();
		expect(serverFns.importSession).not.toHaveBeenCalled();
	});

	it("stops paging when a provider repeats its cursor", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.18.16" },
			canListSessions: true,
		});
		serverFns.listSessions
			.mockResolvedValueOnce({
				sessions: [],
				canImportSessions: true,
				nextCursor: "repeat",
			})
			.mockResolvedValueOnce({
				sessions: [],
				canImportSessions: true,
				nextCursor: "repeat",
			});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("installed OpenCode 1.18.16");
		fireEvent.click(
			screen.getByRole("button", { name: "Browse provider sessions" }),
		);
		await screen.findByRole("button", { name: "Load more" });
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));

		await screen.findByText("The provider returned a repeated session cursor.");
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("preserves the last-good catalog when an explicit refresh fails", async () => {
		let rejectRefresh: (reason: Error) => void = () => {};
		serverFns.registry.mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectRefresh = reject;
				}),
		);
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(
			screen.getByText("OpenCode CLI found · verify the ACP connection"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refreshing…" })).toBeTruthy();
		rejectRefresh(new Error("ACP registry refresh timed out"));

		expect(
			await screen.findByText("ACP registry refresh timed out"),
		).toBeTruthy();
		expect(
			screen.getByText("OpenCode CLI found · verify the ACP connection"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
		expect(serverFns.refreshUpdates).not.toHaveBeenCalled();
	});

	it("clears negotiated identity when catalog invocation metadata changes", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		const first = item("opencode", "OpenCode");
		const view = render(
			<AcpSection
				initialCatalog={[first]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("installed OpenCode 1.2.3");

		view.rerender(
			<AcpSection
				initialCatalog={[{ ...first, args: ["--new"] }]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);
		await waitFor(() =>
			expect(screen.queryByText("installed OpenCode 1.2.3")).toBeNull(),
		);
	});

	it("clears prior inspection evidence after a manual catalog refresh", async () => {
		serverFns.authenticate.mockResolvedValue({
			authMethods: [{ id: "login", name: "OpenCode login" }],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		serverFns.registry.mockResolvedValue([
			{
				...item("opencode", "OpenCode"),
				available: false,
				unavailableReason: "OpenCode CLI is no longer available",
				targets: [
					{
						...item("opencode", "OpenCode").targets[0],
						provenance: "missing",
						available: false,
						canEnable: false,
						installGuidance: "Install OpenCode",
					},
				],
			},
		]);
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onRefreshProviders={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Verify OpenCode ACP" }),
		);
		await screen.findByText("installed OpenCode 1.2.3");
		expect(screen.getByText("OpenCode login")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Refresh models & modes" }),
		);
		await screen.findByText("Models and modes refreshed for this workspace.");

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		await screen.findByText("OpenCode CLI not found");
		expect(serverFns.refreshUpdates).toHaveBeenCalledOnce();
		expect(screen.queryByText("installed OpenCode 1.2.3")).toBeNull();
		expect(screen.queryByText("OpenCode login")).toBeNull();
		expect(
			screen.queryByText("Models and modes refreshed for this workspace."),
		).toBeNull();
	});

	it("surfaces a failed option refresh and releases the operation lock", async () => {
		const refresh = vi
			.fn()
			.mockRejectedValue(
				new Error("OpenCode option refresh failed; showing cached options"),
			);
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onRefreshProviders={refresh}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh models & modes" }),
		);

		expect(
			await screen.findByText(
				"OpenCode option refresh failed; showing cached options",
			),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "Refresh models & modes",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
	});

	it("reports a successful provider-scoped OpenCode option refresh", async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onRefreshProviders={refresh}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh models & modes" }),
		);

		await screen.findByText("Models and modes refreshed for this workspace.");
		expect(refresh).toHaveBeenCalledWith("acp:opencode");
	});

	it("uses the Forge provider catalog for OpenCode model visibility", () => {
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				providers={[
					{
						id: "acp:opencode",
						label: "OpenCode",
						available: true,
						models: [
							{
								value: "anthropic/claude-sonnet-4-6",
								label: "Claude Sonnet 4.6",
							},
						],
					},
				]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("radio", { name: /Hide selected/i }));
		expect(
			screen.getByRole("checkbox", { name: /Claude Sonnet 4\.6/i }),
		).toBeTruthy();
	});

	it("adapts full model discovery to the OpenCode catalog item", async () => {
		const discover = vi
			.fn()
			.mockResolvedValue([{ value: "openai/gpt-5.4", label: "GPT-5.4" }]);
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onDiscoverModels={discover}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);
		await screen.findByText("Full OpenCode model list refreshed.");
		expect(discover).toHaveBeenCalledWith(
			expect.objectContaining({ id: "opencode", providerId: "acp:opencode" }),
		);
	});

	it("invalidates full-model discovery when a same-ID invocation changes", async () => {
		let resolveDiscovery:
			| ((models: Array<{ value: string; label: string }>) => void)
			| undefined;
		const discover = vi.fn(
			() =>
				new Promise<Array<{ value: string; label: string }>>((resolve) => {
					resolveDiscovery = resolve;
				}),
		);
		const original = item("opencode", "OpenCode");
		const view = render(
			<AcpSection
				initialCatalog={[original]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onDiscoverModels={discover}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Refresh full model list" }),
		);
		view.rerender(
			<AcpSection
				initialCatalog={[
					{
						...original,
						args: ["acp", "--new"],
						targets: original.targets.map((target) => ({
							...target,
							args: ["acp", "--new"],
						})),
					},
				]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onDiscoverModels={discover}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("opencode acp --new")).toBeTruthy(),
		);
		await act(async () => {
			resolveDiscovery?.([
				{ value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
			]);
		});

		expect(discover).toHaveBeenCalledWith(original);
		expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
		expect(
			screen.queryByText("Full OpenCode model list refreshed."),
		).toBeNull();
	});

	it("does not inspect or refresh before an edited runtime configuration is saved", () => {
		const refresh = vi.fn();
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode", executable: "/new/opencode" }]}
				savedValue={[{ id: "opencode", executable: "/old/opencode" }]}
				onChange={vi.fn()}
				onRefreshProviders={refresh}
			/>,
		);

		const waiting = screen.getAllByRole("button", {
			name: "Waiting for saved configuration…",
		});
		expect(waiting).toHaveLength(2);
		for (const button of waiting) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(button);
		}
		expect(serverFns.authenticate).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("does not run live actions or discover models while runtime configuration is pending", () => {
		const refreshOptions = vi.fn();
		const discover = vi.fn().mockResolvedValue([]);
		serverFns.authenticate.mockResolvedValue({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		render(
			<AcpSection
				initialCatalog={[item("opencode", "OpenCode")]}
				value={[{ id: "opencode" }]}
				savedValue={[{ id: "opencode" }]}
				workspaceConfigurationCurrent={false}
				onChange={vi.fn()}
				onRefreshProviders={refreshOptions}
				onDiscoverModels={discover}
			/>,
		);

		const discoverModels = screen.getByRole("button", {
			name: "Refresh full model list",
		}) as HTMLButtonElement;
		const inspect = screen.getAllByRole("button", {
			name: "Waiting for saved configuration…",
		});
		expect(inspect).toHaveLength(2);
		expect(discoverModels.disabled).toBe(true);
		fireEvent.click(discoverModels);
		for (const button of inspect) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(button);
		}
		expect(discover).not.toHaveBeenCalled();
		expect(serverFns.authenticate).not.toHaveBeenCalled();
		expect(refreshOptions).not.toHaveBeenCalled();
	});

	it("unlocks live actions after persistence even if catalog refresh fails", () => {
		render(
			<AcpSection
				initialCatalog={[{ ...item("opencode", "OpenCode"), enabled: false }]}
				value={[{ id: "opencode" }]}
				savedValue={[{ id: "opencode" }]}
				onChange={vi.fn()}
				onRefreshProviders={vi.fn()}
			/>,
		);

		expect(
			(
				screen.getByRole("button", {
					name: "Verify OpenCode ACP",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(
			(
				screen.getByRole("button", {
					name: "Refresh models & modes",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("persists the exact verified target only when enabling an agent", () => {
		const onChange = vi.fn();
		const opencode = item("opencode", "OpenCode");
		render(
			<AcpSection
				initialCatalog={[
					{
						...opencode,
						enabled: false,
						targets: [
							{
								...opencode.targets[0],
								recommended: false,
								selected: false,
							},
							wslTarget(),
						],
					},
				]}
				value={[]}
				onChange={onChange}
			/>,
		);

		expect(
			(
				screen.getByRole("combobox", {
					name: "OpenCode execution environment",
				}) as HTMLSelectElement
			).value,
		).toBe("wsl-ubuntu");
		fireEvent.click(screen.getByRole("button", { name: "Enable" }));

		expect(onChange).toHaveBeenCalledWith([
			{
				id: "opencode",
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
			},
		]);
	});

	it("keeps exact-target configuration reachable for an unsupported external install", () => {
		const onChange = vi.fn();
		const opencode = item("opencode", "OpenCode");
		render(
			<AcpSection
				initialCatalog={[
					{
						...opencode,
						enabled: false,
						available: false,
						targets: [
							wslTarget({
								provenance: "missing",
								available: false,
								canEnable: false,
								canInstall: false,
								canRemove: false,
								installedVersion: undefined,
							}),
						],
					},
				]}
				value={[]}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Enable" }));
		expect(onChange).toHaveBeenCalledWith([
			{
				id: "opencode",
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
			},
		]);
	});

	it("starts a confirmed managed installation and shows its progress", async () => {
		serverFns.mutate.mockResolvedValue({
			id: "operation-1",
			action: "install",
			phase: "downloading",
			received: 1024,
			total: 2048,
			cancelable: true,
		});
		const opencode = item("opencode", "OpenCode");
		render(
			<AcpSection
				initialCatalog={[
					{
						...opencode,
						enabled: false,
						available: false,
						targets: [
							wslTarget({
								provenance: "missing",
								available: false,
								canEnable: false,
								canInstall: true,
								canRemove: false,
								installedVersion: undefined,
							}),
						],
					},
				]}
				value={[]}
				onChange={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "install" }));

		await waitFor(() =>
			expect(serverFns.mutate).toHaveBeenCalledWith({
				action: "install",
				agentId: "opencode",
				targetId: "wsl-ubuntu",
				revision: mutationRevision,
			}),
		);
		expect((await screen.findByRole("status")).textContent).toContain(
			"Installing · Downloading · 1 KB of 2 KB",
		);
	});

	it("polls the catalog until a managed operation settles", async () => {
		vi.useFakeTimers();
		const opencode = item("opencode", "OpenCode");
		serverFns.registry
			.mockResolvedValueOnce([
				{
					...opencode,
					enabled: false,
					targets: [
						wslTarget({
							operation: {
								id: "operation-1",
								action: "install",
								phase: "refreshing",
								cancelable: false,
							},
						}),
					],
				},
			])
			.mockResolvedValueOnce([
				{
					...opencode,
					enabled: false,
					targets: [wslTarget()],
				},
			]);
		render(
			<AcpSection
				initialCatalog={[
					{
						...opencode,
						enabled: false,
						targets: [
							wslTarget({
								available: false,
								canEnable: false,
								operation: {
									id: "operation-1",
									action: "install",
									phase: "probing",
									cancelable: false,
								},
							}),
						],
					},
				]}
				value={[]}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByRole("status").textContent).toContain(
			"Installing · Probing",
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});

		expect(serverFns.registry).toHaveBeenCalledOnce();
		expect(serverFns.refreshUpdates).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toContain(
			"Installing · Refreshing",
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});

		expect(serverFns.registry).toHaveBeenCalledTimes(2);
		expect(serverFns.refreshUpdates).toHaveBeenCalledOnce();
		expect(screen.getByText(/Managed by Hlid/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_000);
		});
		expect(serverFns.refreshUpdates).toHaveBeenCalledOnce();
	});

	it("reopens on the non-recommended WSL target with managed state", () => {
		const opencode = item("opencode", "OpenCode");
		const ubuntu = wslTarget({
			targetId: "wsl-ubuntu",
			recommended: true,
			selected: false,
			provenance: "missing",
			available: false,
			canEnable: false,
			canRemove: false,
		});
		const debian = wslTarget({
			targetId: "wsl-debian",
			target: { kind: "wsl", distro: "Debian" },
			label: "WSL · Debian",
			recommended: false,
			selected: false,
			operation: {
				id: "operation-1",
				action: "install",
				phase: "probing",
				cancelable: false,
			},
		});
		const catalog = [
			{ ...opencode, enabled: false, targets: [ubuntu, debian] },
		];

		render(
			<AcpSection initialCatalog={catalog} value={[]} onChange={vi.fn()} />,
		);
		expect(
			(
				screen.getByRole("combobox", {
					name: "OpenCode execution environment",
				}) as HTMLSelectElement
			).value,
		).toBe("wsl-debian");
		cleanup();

		render(
			<AcpSection
				initialCatalog={[
					{
						...opencode,
						enabled: false,
						targets: [ubuntu, { ...debian, operation: undefined }],
					},
				]}
				value={[]}
				onChange={vi.fn()}
			/>,
		);
		expect(
			(
				screen.getByRole("combobox", {
					name: "OpenCode execution environment",
				}) as HTMLSelectElement
			).value,
		).toBe("wsl-debian");
		expect(screen.getByText(/Managed by Hlid · WSL · Debian/)).toBeTruthy();
	});

	it("waits for a disable save before enabling managed removal", () => {
		const opencode = item("opencode", "OpenCode");
		const props = {
			initialCatalog: [{ ...opencode, targets: [wslTarget()] }],
			value: [],
			onChange: vi.fn(),
		};
		const { rerender } = render(
			<AcpSection
				{...props}
				savedValue={[
					{
						id: "opencode",
						target: { kind: "wsl", distro: "Ubuntu-24.04" },
					},
				]}
			/>,
		);
		expect(
			(screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		rerender(<AcpSection {...props} savedValue={[]} />);
		expect(
			(screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});
});
