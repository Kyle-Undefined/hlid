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
			turn_recaps: true,
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
		attachments: { max_bytes: 1, allowed_mimes: [] },
		voice: {
			enabled: false,
			model: "",
			language: "auto",
			auto_send: false,
			read_aloud_provider: "device",
			read_aloud_voice: "",
			read_aloud_rate: 1,
			hotkey: "Alt+Shift+KeyV",
			max_recording_seconds: 300,
			threads: 4,
			vocabulary: ["Claude", "Codex"],
		},
		umbod: { enabled: false, manifest_path: "umbod.toml" },
		auto_sleep: {
			enabled: false,
			threshold: 0.95,
			max_sleep_minutes: 360,
			resume_buffer_seconds: 60,
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
