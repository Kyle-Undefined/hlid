// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AcpAgentInfo,
	AcpAuthMethod,
	AcpCatalogItem,
} from "#/lib/serverFns/acp";
import { AcpAgentCard, type AcpAgentConfig } from "./AcpAgentCard";

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
		busy: boolean;
		disabled: boolean;
		authMethods: AcpAuthMethod[] | undefined;
		agentInfo: AcpAgentInfo | null | undefined;
		onToggle: () => void;
		onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
		onInspect: (methodId?: string) => void;
		onRefreshOptions: () => void;
	}>,
) {
	const props = {
		item: makeItem(),
		configured: undefined,
		busy: false,
		disabled: false,
		authMethods: undefined,
		agentInfo: undefined,
		onToggle: vi.fn(),
		onUpdateOverride: vi.fn(),
		onInspect: vi.fn(),
		onRefreshOptions: vi.fn(),
		...overrides,
	};
	render(<AcpAgentCard {...props} />);
	return props;
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
			busy: true,
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
});
