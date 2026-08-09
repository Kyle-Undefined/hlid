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
		operation: "inspect" | "refresh" | null;
		disabled: boolean;
		authMethods: AcpAuthMethod[] | undefined;
		agentInfo: AcpAgentInfo | null | undefined;
		optionsRefreshed: boolean;
		configurationCurrent: boolean;
		onToggle: () => void;
		onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
		onInspect: (methodId?: string) => void;
		onRefreshOptions: () => void;
	}>,
) {
	const props = {
		item: makeItem(),
		configured: undefined,
		operation: null,
		disabled: false,
		authMethods: undefined,
		agentInfo: undefined,
		optionsRefreshed: false,
		configurationCurrent: true,
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
