/**
 * agentMcp — unit tests for validateAgentPath, writeAgentMcpFile, toggleAgentMcpFile.
 * Uses real temp directories; no fs mocking required.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HlidConfig } from "../config";
import {
	readAgentMcpFile,
	toggleAgentMcpFile,
	validateAgentPath,
	writeAgentMcpFile,
} from "./agentMcp";

let agentDir: string;
let otherDir: string;

function makeConfig(agentPaths: string[] = []): HlidConfig {
	return {
		vault: {
			name: "Vault",
			path: "/fake/vault",
			delete_vault_attachments: false,
		},
		server: {
			port: 3000,
			tls_proxy_port: 3443,
			local_network_access: false,
			allow_external_agents: false,
		},
		claude: {
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: "default",
			turn_recaps: false,
			interactive_mode: false,
		},
		cliproxy: {
			enabled: false,
			mode: "external",
			base_url: "http://127.0.0.1:8317",
			api_key: "",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permission_mode: "default",
			turn_recaps: true,
		},
		codex: {
			model: "",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: false,
			windows_computer_use: { model: "inherit", effort: "medium" },
		},
		ui: {
			enter_to_submit: true,
			hide_skills_index: false,
			show_provider_entries: false,
			theme: "tan",
			html_plans: false,
		},
		status_vocabulary: { active: [], planning: [], done: [] },
		attachments: { max_bytes: 25 * 1024 * 1024, allowed_mimes: [] },
		voice: {
			enabled: false,
			model: "",
			language: "auto",
			auto_send: false,
			hotkey: "Alt+Shift+KeyV",
			max_recording_seconds: 300,
		},
		umbod: { enabled: false, manifest_path: "umbod.toml" },
		auto_sleep: {
			enabled: false,
			threshold: 0.95,
			max_sleep_minutes: 360,
			resume_buffer_seconds: 60,
		},
		vault_provider: "claude",
		agents: agentPaths.map((p) => ({
			path: p,
			name: "test",
			mode: "cwd" as const,
			provider: "claude",
		})),
	} as HlidConfig;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "hlid-agent-"));
	otherDir = mkdtempSync(join(tmpdir(), "hlid-other-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(otherDir, { recursive: true, force: true });
});

// ── readAgentMcpFile ─────────────────────────────────────────────────────────

describe("readAgentMcpFile", () => {
	it("returns empty servers when .mcp.json is missing", () => {
		expect(readAgentMcpFile(agentDir)).toEqual({ servers: [] });
	});

	it("returns servers with disabled=false when settings.local.json is missing", () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { filesystem: { command: "npx" } } }),
			"utf8",
		);
		expect(readAgentMcpFile(agentDir)).toEqual({
			servers: [
				{ name: "filesystem", config: { command: "npx" }, disabled: false },
			],
		});
	});

	it("marks servers as disabled based on settings.local.json", () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					filesystem: { command: "npx" },
					brave: { command: "uvx" },
				},
			}),
			"utf8",
		);
		mkdirSync(join(agentDir, ".claude"), { recursive: true });
		writeFileSync(
			join(agentDir, ".claude", "settings.local.json"),
			JSON.stringify({ disabledMcpjsonServers: ["filesystem"] }),
			"utf8",
		);
		const result = readAgentMcpFile(agentDir);
		expect(result.servers.find((s) => s.name === "filesystem")?.disabled).toBe(
			true,
		);
		expect(result.servers.find((s) => s.name === "brave")?.disabled).toBe(
			false,
		);
	});

	it("returns empty servers when mcpServers key is absent", () => {
		writeFileSync(join(agentDir, ".mcp.json"), JSON.stringify({}), "utf8");
		expect(readAgentMcpFile(agentDir)).toEqual({ servers: [] });
	});
});

// ── validateAgentPath ────────────────────────────────────────────────────────

describe("validateAgentPath", () => {
	it("passes for registered agent path", () => {
		const config = makeConfig([agentDir]);
		expect(() => validateAgentPath(agentDir, config)).not.toThrow();
	});

	it("throws Unauthorized for unregistered path", () => {
		const config = makeConfig([agentDir]);
		expect(() => validateAgentPath(otherDir, config)).toThrow("Unauthorized");
	});

	it("throws Unauthorized when agents list is empty", () => {
		const config = makeConfig([]);
		expect(() => validateAgentPath(agentDir, config)).toThrow("Unauthorized");
	});
});

// ── writeAgentMcpFile ────────────────────────────────────────────────────────

describe("writeAgentMcpFile", () => {
	it("creates .mcp.json with mcpServers wrapper", () => {
		const servers = { "my-server": { command: "npx", args: ["-y", "server"] } };
		writeAgentMcpFile(agentDir, servers);
		const written = JSON.parse(
			readFileSync(join(agentDir, ".mcp.json"), "utf8"),
		);
		expect(written).toEqual({ mcpServers: servers });
	});

	it("overwrites existing .mcp.json", () => {
		writeFileSync(
			join(agentDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { old: {} } }),
			"utf8",
		);
		const servers = { "new-server": { command: "bun", args: ["server.ts"] } };
		writeAgentMcpFile(agentDir, servers);
		const written = JSON.parse(
			readFileSync(join(agentDir, ".mcp.json"), "utf8"),
		);
		expect(Object.keys(written.mcpServers)).toEqual(["new-server"]);
		expect(Object.keys(written.mcpServers)).not.toContain("old");
	});

	it("writes empty mcpServers when passed empty object", () => {
		writeAgentMcpFile(agentDir, {});
		const written = JSON.parse(
			readFileSync(join(agentDir, ".mcp.json"), "utf8"),
		);
		expect(written.mcpServers).toEqual({});
	});
});

// ── toggleAgentMcpFile ───────────────────────────────────────────────────────

describe("toggleAgentMcpFile", () => {
	it("adds name to disabledMcpjsonServers when disabled=true", () => {
		toggleAgentMcpFile(agentDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(agentDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).toContain("my-server");
	});

	it("removes name from disabledMcpjsonServers when disabled=false", () => {
		mkdirSync(join(agentDir, ".claude"), { recursive: true });
		writeFileSync(
			join(agentDir, ".claude", "settings.local.json"),
			JSON.stringify({
				disabledMcpjsonServers: ["my-server", "other-server"],
			}),
			"utf8",
		);
		toggleAgentMcpFile(agentDir, "my-server", false);
		const settings = JSON.parse(
			readFileSync(join(agentDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).not.toContain("my-server");
		expect(settings.disabledMcpjsonServers).toContain("other-server");
	});

	it("creates .claude/ directory if missing", () => {
		toggleAgentMcpFile(agentDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(agentDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).toEqual(["my-server"]);
	});

	it("preserves other keys in settings.local.json", () => {
		mkdirSync(join(agentDir, ".claude"), { recursive: true });
		writeFileSync(
			join(agentDir, ".claude", "settings.local.json"),
			JSON.stringify({
				existingKey: "value",
				disabledMcpjsonServers: [],
			}),
			"utf8",
		);
		toggleAgentMcpFile(agentDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(agentDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.existingKey).toBe("value");
	});

	it("is idempotent when adding already-disabled server", () => {
		mkdirSync(join(agentDir, ".claude"), { recursive: true });
		writeFileSync(
			join(agentDir, ".claude", "settings.local.json"),
			JSON.stringify({ disabledMcpjsonServers: ["my-server"] }),
			"utf8",
		);
		toggleAgentMcpFile(agentDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(agentDir, ".claude", "settings.local.json"), "utf8"),
		);
		const count = (settings.disabledMcpjsonServers as string[]).filter(
			(s) => s === "my-server",
		).length;
		expect(count).toBe(1);
	});
});
