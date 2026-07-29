import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeConfig as makeBaseConfig } from "#/test/fixtures";
import type { HlidConfig } from "../config";
import { resolveAllowedTerminalCwd } from "./terminalAccess";

const roots: string[] = [];

function makeDir(name: string): string {
	const root = mkdtempSync(join(tmpdir(), "hlid-terminal-access-"));
	roots.push(root);
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const makeConfig = (vaultPath: string, agentPaths: string[] = []): HlidConfig =>
	makeBaseConfig({
		vault: { name: "Vault", path: vaultPath },
		agents: agentPaths.map((path) => ({
			path,
			mode: "cwd" as const,
			provider: "claude" as const,
		})),
	});

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resolveAllowedTerminalCwd", () => {
	it("allows the configured vault path", () => {
		const vault = makeDir("vault");
		expect(resolveAllowedTerminalCwd(makeConfig(vault), vault)).toBe(vault);
	});

	it("allows a configured agent path", () => {
		const vault = makeDir("vault");
		const agent = makeDir("agent");
		expect(resolveAllowedTerminalCwd(makeConfig(vault, [agent]), agent)).toBe(
			agent,
		);
	});

	it("rejects an unregistered existing path", () => {
		const vault = makeDir("vault");
		const other = makeDir("other");
		expect(resolveAllowedTerminalCwd(makeConfig(vault), other)).toBeNull();
	});

	it("rejects a missing requested path", () => {
		const vault = makeDir("vault");
		expect(
			resolveAllowedTerminalCwd(makeConfig(vault), join(vault, "missing")),
		).toBeNull();
	});
});
