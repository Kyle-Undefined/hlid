/**
 * vaultMcp — unit tests for readVaultMcpFile, writeVaultMcpFile, toggleVaultMcpFile.
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
import {
	readVaultMcpFile,
	toggleVaultMcpFile,
	writeVaultMcpFile,
} from "./vaultMcp";

let vaultDir: string;

beforeEach(() => {
	vaultDir = mkdtempSync(join(tmpdir(), "hlid-vault-"));
});

afterEach(() => {
	rmSync(vaultDir, { recursive: true, force: true });
});

// ── readVaultMcpFile ─────────────────────────────────────────────────────────

describe("readVaultMcpFile", () => {
	it("returns empty servers when .mcp.json is missing", () => {
		expect(readVaultMcpFile(vaultDir)).toEqual({ servers: [] });
	});

	it("returns servers with disabled=false when settings.local.json is missing", () => {
		writeFileSync(
			join(vaultDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { filesystem: { command: "npx" } } }),
			"utf8",
		);
		expect(readVaultMcpFile(vaultDir)).toEqual({
			servers: [
				{ name: "filesystem", config: { command: "npx" }, disabled: false },
			],
		});
	});

	it("marks servers as disabled based on settings.local.json", () => {
		writeFileSync(
			join(vaultDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					filesystem: { command: "npx" },
					brave: { command: "uvx" },
				},
			}),
			"utf8",
		);
		mkdirSync(join(vaultDir, ".claude"), { recursive: true });
		writeFileSync(
			join(vaultDir, ".claude", "settings.local.json"),
			JSON.stringify({ disabledMcpjsonServers: ["filesystem"] }),
			"utf8",
		);
		const result = readVaultMcpFile(vaultDir);
		expect(result.servers.find((s) => s.name === "filesystem")?.disabled).toBe(
			true,
		);
		expect(result.servers.find((s) => s.name === "brave")?.disabled).toBe(
			false,
		);
	});

	it("returns empty servers when mcpServers key is absent", () => {
		writeFileSync(join(vaultDir, ".mcp.json"), JSON.stringify({}), "utf8");
		expect(readVaultMcpFile(vaultDir)).toEqual({ servers: [] });
	});

	it("returns all servers as not disabled when disabledMcpjsonServers is absent", () => {
		writeFileSync(
			join(vaultDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { a: {}, b: {} } }),
			"utf8",
		);
		mkdirSync(join(vaultDir, ".claude"), { recursive: true });
		writeFileSync(
			join(vaultDir, ".claude", "settings.local.json"),
			JSON.stringify({ otherKey: true }),
			"utf8",
		);
		const result = readVaultMcpFile(vaultDir);
		expect(result.servers.every((s) => !s.disabled)).toBe(true);
	});
});

// ── writeVaultMcpFile ────────────────────────────────────────────────────────

describe("writeVaultMcpFile", () => {
	it("creates .mcp.json with mcpServers wrapper", () => {
		const servers = { "my-server": { command: "npx", args: ["-y", "server"] } };
		writeVaultMcpFile(vaultDir, servers);
		const written = JSON.parse(
			readFileSync(join(vaultDir, ".mcp.json"), "utf8"),
		);
		expect(written).toEqual({ mcpServers: servers });
	});

	it("overwrites existing .mcp.json", () => {
		writeFileSync(
			join(vaultDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { old: {} } }),
			"utf8",
		);
		writeVaultMcpFile(vaultDir, { new: { command: "x" } });
		const written = JSON.parse(
			readFileSync(join(vaultDir, ".mcp.json"), "utf8"),
		);
		expect(Object.keys(written.mcpServers)).toEqual(["new"]);
	});

	it("writes empty mcpServers when passed empty object", () => {
		writeVaultMcpFile(vaultDir, {});
		const written = JSON.parse(
			readFileSync(join(vaultDir, ".mcp.json"), "utf8"),
		);
		expect(written.mcpServers).toEqual({});
	});
});

// ── toggleVaultMcpFile ───────────────────────────────────────────────────────

describe("toggleVaultMcpFile", () => {
	it("adds name to disabledMcpjsonServers when disabled=true", () => {
		toggleVaultMcpFile(vaultDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(vaultDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).toContain("my-server");
	});

	it("removes name from disabledMcpjsonServers when disabled=false", () => {
		mkdirSync(join(vaultDir, ".claude"), { recursive: true });
		writeFileSync(
			join(vaultDir, ".claude", "settings.local.json"),
			JSON.stringify({
				disabledMcpjsonServers: ["my-server", "other-server"],
			}),
			"utf8",
		);
		toggleVaultMcpFile(vaultDir, "my-server", false);
		const settings = JSON.parse(
			readFileSync(join(vaultDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).not.toContain("my-server");
		expect(settings.disabledMcpjsonServers).toContain("other-server");
	});

	it("creates .claude/ directory if missing", () => {
		toggleVaultMcpFile(vaultDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(vaultDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.disabledMcpjsonServers).toEqual(["my-server"]);
	});

	it("preserves other keys in settings.local.json", () => {
		mkdirSync(join(vaultDir, ".claude"), { recursive: true });
		writeFileSync(
			join(vaultDir, ".claude", "settings.local.json"),
			JSON.stringify({ existingKey: "value", disabledMcpjsonServers: [] }),
			"utf8",
		);
		toggleVaultMcpFile(vaultDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(vaultDir, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.existingKey).toBe("value");
	});

	it("is idempotent when adding already-disabled server", () => {
		mkdirSync(join(vaultDir, ".claude"), { recursive: true });
		writeFileSync(
			join(vaultDir, ".claude", "settings.local.json"),
			JSON.stringify({ disabledMcpjsonServers: ["my-server"] }),
			"utf8",
		);
		toggleVaultMcpFile(vaultDir, "my-server", true);
		const settings = JSON.parse(
			readFileSync(join(vaultDir, ".claude", "settings.local.json"), "utf8"),
		);
		const count = (settings.disabledMcpjsonServers as string[]).filter(
			(s) => s === "my-server",
		).length;
		expect(count).toBe(1);
	});
});
