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

		const inspect = screen.getAllByRole("button", { name: "Inspect agent" });
		fireEvent.click(inspect[0]);
		expect((inspect[1] as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(inspect[1]);
		expect(serverFns.authenticate).toHaveBeenCalledOnce();

		finish?.({
			authMethods: [],
			agentInfo: { name: "OpenCode", version: "1.2.3" },
		});
		await waitFor(() =>
			expect(screen.getByText("initialized OpenCode 1.2.3")).toBeTruthy(),
		);
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
		fireEvent.click(screen.getByRole("button", { name: "Inspect agent" }));
		await screen.findByText("initialized OpenCode 1.2.3");

		view.rerender(
			<AcpSection
				initialCatalog={[{ ...first, args: ["--new"] }]}
				value={[{ id: "opencode" }]}
				onChange={vi.fn()}
			/>,
		);
		await waitFor(() =>
			expect(screen.queryByText("initialized OpenCode 1.2.3")).toBeNull(),
		);
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

		fireEvent.click(screen.getByRole("button", { name: "Refresh options" }));

		expect(
			await screen.findByText(
				"OpenCode option refresh failed; showing cached options",
			),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "Refresh options",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
	});
});
