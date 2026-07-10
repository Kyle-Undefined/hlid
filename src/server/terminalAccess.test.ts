import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function makeConfig(vaultPath: string, agentPaths: string[] = []): HlidConfig {
	return {
		vault: {
			name: "Vault",
			path: vaultPath,
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
			turn_recaps: true,
			interactive_mode: false,
		},
		codex: {
			model: "",
			effort: "medium",
			permission_mode: "default",
			turn_recaps: true,
		},
		ui: { enter_to_submit: true, hide_skills_index: false, theme: "tan" },
		status_vocabulary: { active: [], planning: [], done: [] },
		attachments: { max_bytes: 1, allowed_mimes: [] },
		voice: {
			enabled: false,
			model: "",
			language: "auto",
			auto_send: false,
			hotkey: "Alt+Shift+KeyV",
			max_recording_seconds: 300,
		},
		vault_provider: "claude",
		agents: agentPaths.map((path) => ({
			path,
			mode: "cwd" as const,
			provider: "claude" as const,
		})),
	};
}

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
