// @vitest-environment jsdom
import {
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

const serverFns = vi.hoisted(() => ({
	authenticate: vi.fn(),
	registry: vi.fn(),
}));

vi.mock("#/lib/serverFns/acp", () => ({
	authenticateAcpFn: serverFns.authenticate,
	getAcpRegistryFn: serverFns.registry,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
});
