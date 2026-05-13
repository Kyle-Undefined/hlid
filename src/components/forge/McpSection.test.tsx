// @vitest-environment jsdom
/**
 * Tests for the shared McpServerManager component.
 * Server functions are injected as props — no module mocking needed.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerManager } from "./McpSection";
import type { VaultMcpConfig, VaultMcpServer } from "./McpServerForm";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("#/hooks/useWs", () => ({
	useWs: vi.fn(() => ({ send: vi.fn() })),
}));

// ── lifecycle ─────────────────────────────────────────────────────────────────

afterEach(cleanup);

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<VaultMcpServer> = {}): VaultMcpServer {
	return {
		name: "test-server",
		config: {
			type: "stdio",
			command: "node",
			args: [],
			env: {},
		} as VaultMcpConfig,
		disabled: false,
		...overrides,
	};
}

function makeProps(
	overrides: Partial<Parameters<typeof McpServerManager>[0]> = {},
): Parameters<typeof McpServerManager>[0] {
	return {
		title: "MCP",
		agentCwd: null,
		loadServers: vi.fn().mockResolvedValue({ servers: [] }),
		writeServers: vi.fn().mockResolvedValue(undefined),
		toggleServer: vi.fn().mockResolvedValue(undefined),
		loadLiveStatus: vi.fn().mockResolvedValue([]),
		showCloudServers: false,
		showProbe: false,
		syncAfterWrite: false,
		footer: undefined,
		...overrides,
	};
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("McpServerManager", () => {
	describe("loading + display", () => {
		it("renders loading state then shows server list", async () => {
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({ servers: [makeServer()] }),
			});
			render(<McpServerManager {...props} />);
			expect(screen.getByText("loading…")).not.toBeNull();
			await screen.findByText("test-server");
			expect(screen.queryByText("loading…")).toBeNull();
		});

		it("renders empty state with add button when no servers", async () => {
			render(<McpServerManager {...makeProps()} />);
			const addBtn = await screen.findByText("+ ADD SERVER");
			expect(addBtn).not.toBeNull();
		});

		it("shows all loaded server names", async () => {
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [
						makeServer({ name: "alpha" }),
						makeServer({ name: "beta" }),
					],
				}),
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("alpha");
			expect(screen.getByText("beta")).not.toBeNull();
		});
	});

	describe("toggle", () => {
		it("calls toggleServer with correct payload", async () => {
			const toggleServer = vi.fn().mockResolvedValue(undefined);
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [makeServer({ name: "srv1", disabled: false })],
				}),
				toggleServer,
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("srv1");

			// The "on" checkbox — click to disable
			const checkbox = screen.getByRole("checkbox");
			fireEvent.click(checkbox);

			expect(toggleServer).toHaveBeenCalledWith("srv1", true);
		});

		it("shows opError when toggle throws", async () => {
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [makeServer({ name: "srv1" })],
				}),
				toggleServer: vi.fn().mockRejectedValue(new Error("Permission denied")),
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("srv1");

			fireEvent.click(screen.getByRole("checkbox"));

			await screen.findByText("Permission denied");
		});
	});

	describe("remove", () => {
		it("calls writeServers with the server filtered out after confirm", async () => {
			const writeServers = vi.fn().mockResolvedValue(undefined);
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [
						makeServer({ name: "to-remove" }),
						makeServer({ name: "keep-me" }),
					],
				}),
				writeServers,
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("to-remove");

			// Click the × button for "to-remove" (first one) to open confirm UI
			const removeButtons = screen.getAllByText("×");
			fireEvent.click(removeButtons[0]);

			// ConfirmAction shows label "remove?" + button "confirm" — click confirm
			const confirmBtn = await screen.findByText("confirm");
			fireEvent.click(confirmBtn);

			await waitFor(() => {
				expect(writeServers).toHaveBeenCalledWith(
					expect.not.objectContaining({ "to-remove": expect.anything() }),
				);
				expect(writeServers).toHaveBeenCalledWith(
					expect.objectContaining({ "keep-me": expect.anything() }),
				);
			});
		});
	});

	describe("add", () => {
		it("calls writeServers with new entry and hides form on success", async () => {
			const writeServers = vi.fn().mockResolvedValue(undefined);
			const props = makeProps({ writeServers });
			render(<McpServerManager {...props} />);

			fireEvent.click(await screen.findByText("+ ADD SERVER"));

			// Name field placeholder is "my-server", command placeholder is "npx"
			const nameInput = screen.getByPlaceholderText("my-server");
			fireEvent.change(nameInput, { target: { value: "new-server" } });

			const cmdInput = screen.getByPlaceholderText("npx");
			fireEvent.change(cmdInput, { target: { value: "my-cmd" } });

			// Submit button text is "ADD"
			fireEvent.click(screen.getByText("ADD"));

			await waitFor(() => {
				expect(writeServers).toHaveBeenCalledWith(
					expect.objectContaining({ "new-server": expect.anything() }),
				);
			});
		});

		it("shows error when adding a server with a duplicate name", async () => {
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [makeServer({ name: "existing" })],
				}),
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("existing");

			fireEvent.click(screen.getByText("+ ADD SERVER"));
			const nameInput = screen.getByPlaceholderText("my-server");
			fireEvent.change(nameInput, { target: { value: "existing" } });

			const cmdInput = screen.getByPlaceholderText("npx");
			fireEvent.change(cmdInput, { target: { value: "cmd" } });

			fireEvent.click(screen.getByText("ADD"));

			await screen.findByText(/already exists/i);
		});
	});

	describe("edit", () => {
		it("calls writeServers with updated config on save", async () => {
			const writeServers = vi.fn().mockResolvedValue(undefined);
			const props = makeProps({
				loadServers: vi.fn().mockResolvedValue({
					servers: [
						makeServer({
							name: "editable",
							config: { type: "stdio", command: "old-cmd" },
						}),
					],
				}),
				writeServers,
			});
			render(<McpServerManager {...props} />);
			await screen.findByText("editable");

			fireEvent.click(screen.getByText("edit"));

			// Update command field in edit form
			const cmdInput = screen.getByDisplayValue("old-cmd");
			fireEvent.change(cmdInput, { target: { value: "new-cmd" } });

			fireEvent.click(screen.getByText(/save/i));

			await waitFor(() => {
				expect(writeServers).toHaveBeenCalledWith(
					expect.objectContaining({
						editable: expect.objectContaining({ command: "new-cmd" }),
					}),
				);
			});
		});
	});

	describe("cloud servers (vault variant)", () => {
		it("renders cloud servers as read-only when showCloudServers=true", async () => {
			const props = makeProps({
				showCloudServers: true,
				loadLiveStatus: vi.fn().mockResolvedValue([
					{
						name: "claude.ai desktop",
						status: "connected",
						scope: "claudeai",
					},
				]),
			});
			render(<McpServerManager {...props} />);

			await screen.findByText("desktop");
			// No remove button for cloud servers
			expect(screen.queryByText("×")).toBeNull();
		});
	});
});
