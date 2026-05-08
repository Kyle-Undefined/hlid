/**
 * MCP server entry mapping tests — pure logic, no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { mapMcpServer } from "./mcp";

describe("mapMcpServer — displayName", () => {
	it("strips 'claude.ai ' prefix from name", () => {
		const entry = mapMcpServer({
			name: "claude.ai filesystem",
			status: "connected",
		});
		expect(entry.displayName).toBe("filesystem");
	});

	it("uses name as displayName when no claude.ai prefix", () => {
		const entry = mapMcpServer({ name: "my-server", status: "connected" });
		expect(entry.displayName).toBe("my-server");
	});

	it("preserves name unchanged", () => {
		const entry = mapMcpServer({
			name: "claude.ai github",
			status: "connected",
		});
		expect(entry.name).toBe("claude.ai github");
	});
});

describe("mapMcpServer — source", () => {
	it("maps scope=claudeai to cloud", () => {
		const entry = mapMcpServer({
			name: "x",
			status: "connected",
			scope: "claudeai",
		});
		expect(entry.source).toBe("cloud");
	});

	it("maps scope=project to vault", () => {
		const entry = mapMcpServer({
			name: "x",
			status: "connected",
			scope: "project",
		});
		expect(entry.source).toBe("vault");
	});

	it("maps scope=undefined to global", () => {
		const entry = mapMcpServer({ name: "x", status: "connected" });
		expect(entry.source).toBe("global");
	});

	it("maps unknown scope to global", () => {
		const entry = mapMcpServer({
			name: "x",
			status: "connected",
			scope: "something-else",
		});
		expect(entry.source).toBe("global");
	});
});

describe("mapMcpServer — status", () => {
	const valid = [
		"connected",
		"failed",
		"needs-auth",
		"pending",
		"disabled",
		"unknown",
	] as const;

	for (const s of valid) {
		it(`passes through valid status: ${s}`, () => {
			expect(mapMcpServer({ name: "x", status: s }).status).toBe(s);
		});
	}

	it("maps unrecognized status to unknown", () => {
		expect(mapMcpServer({ name: "x", status: "broken-enum" }).status).toBe(
			"unknown",
		);
	});

	it("maps empty string status to unknown", () => {
		expect(mapMcpServer({ name: "x", status: "" }).status).toBe("unknown");
	});
});
