/**
 * writeConfig — verifies TOML serialization output.
 * Mocks writeFileSync and syncWrappers; inspects captured string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
	writeFileSync: vi.fn(),
}));

vi.mock("../server/wrappers", () => ({
	syncWrappers: vi.fn(),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import type { HlidConfig } from "../config";
import { writeConfig } from "./config-writer";

const mockWrite = vi.mocked(writeFileSync);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<HlidConfig> = {}): HlidConfig {
	return {
		vault: { name: "Vault", path: "/my/vault" },
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
		ui: {
			enter_to_submit: true,
			hide_skills_index: true,
			theme: "tan",
		},
		status_vocabulary: {
			active: ["Active", "In Progress"],
			planning: ["Planning"],
			done: ["Done"],
		},
		attachments: { max_bytes: 25 * 1024 * 1024, allowed_mimes: [] },
		agents: [],
		...overrides,
	} as HlidConfig;
}

/** Capture the TOML string passed to writeFileSync. */
function capturedToml(): string {
	expect(mockWrite).toHaveBeenCalled();
	return mockWrite.mock.calls[0][1] as string;
}

beforeEach(() => {
	mockWrite.mockClear();
});

// ── section headers ───────────────────────────────────────────────────────────

describe("writeConfig — section headers", () => {
	it("writes all required section headers", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).toContain("[vault]");
		expect(toml).toContain("[server]");
		expect(toml).toContain("[voice]");
		expect(toml).toContain("[claude]");
		expect(toml).toContain("[ui]");
		expect(toml).toContain("[status_vocabulary]");
	});
});

describe("writeConfig — voice section", () => {
	it("writes the default desktop recording hotkey", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).toContain('hotkey = "Alt+Shift+KeyV"');
	});

	it("allows the recording hotkey to be cleared", () => {
		writeConfig(
			makeConfig({
				voice: {
					enabled: true,
					model: "base",
					language: "auto",
					auto_send: false,
					hotkey: "",
					max_recording_seconds: 300,
				},
			}),
		);
		expect(capturedToml()).toContain('hotkey = ""');
	});
});

// ── vault section ─────────────────────────────────────────────────────────────

describe("writeConfig — vault section", () => {
	it("writes name and path", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).toContain('name = "Vault"');
		expect(toml).toContain('path = "/my/vault"');
	});

	it("writes optional fields when present", () => {
		writeConfig(
			makeConfig({
				vault: {
					name: "V",
					path: "/v",
					style: "para",
					inbox: "inbox",
					projects: "projects",
					skills: "skills",
					memory: "memory",
					delete_vault_attachments: false,
				},
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain('style = "para"');
		expect(toml).toContain('inbox = "inbox"');
		expect(toml).toContain('projects = "projects"');
		expect(toml).toContain('skills = "skills"');
		expect(toml).toContain('memory = "memory"');
	});

	it("omits optional vault fields when absent", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).not.toMatch(/^inbox\s*=/m);
		expect(toml).not.toMatch(/^projects\s*=/m);
		expect(toml).not.toMatch(/^style\s*=/m);
	});
});

// ── server section ────────────────────────────────────────────────────────────

describe("writeConfig — server section", () => {
	it("writes port", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).toContain("port = 3000");
	});

	it("writes local_network_access = true when enabled", () => {
		writeConfig(
			makeConfig({
				server: {
					port: 3000,
					tls_proxy_port: 3443,
					local_network_access: true,
					allow_external_agents: false,
				},
			}),
		);
		expect(capturedToml()).toContain("local_network_access = true");
	});

	it("omits local_network_access when false", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).not.toContain("local_network_access");
	});

	it("writes tls_cert_path and tls_key_path when set", () => {
		writeConfig(
			makeConfig({
				server: {
					port: 3000,
					tls_proxy_port: 3443,
					local_network_access: false,
					allow_external_agents: false,
					tls_cert_path: "/etc/ssl/cert.pem",
					tls_key_path: "/etc/ssl/key.pem",
				},
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain('tls_cert_path = "/etc/ssl/cert.pem"');
		expect(toml).toContain('tls_key_path = "/etc/ssl/key.pem"');
	});
});

// ── claude section ────────────────────────────────────────────────────────────

describe("writeConfig — claude section", () => {
	it("writes model, effort, permission_mode, turn_recaps", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).toContain('model = "claude-sonnet-4-6"');
		expect(toml).toContain('effort = "high"');
		expect(toml).toContain('permission_mode = "default"');
		expect(toml).toContain("turn_recaps = true");
	});

	it("writes turn_recaps = false when disabled", () => {
		writeConfig(
			makeConfig({
				claude: {
					model: "claude-sonnet-4-6",
					effort: "high",
					permission_mode: "default",
					turn_recaps: false,
					interactive_mode: false,
				},
			}),
		);
		expect(capturedToml()).toContain("turn_recaps = false");
	});

	it("writes max_turns when set", () => {
		writeConfig(
			makeConfig({
				claude: {
					model: "m",
					effort: "low",
					permission_mode: "default",
					turn_recaps: true,
					interactive_mode: false,
					max_turns: 10,
				},
			}),
		);
		expect(capturedToml()).toContain("max_turns = 10");
	});

	it("omits max_turns when undefined", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).not.toContain("max_turns");
	});

	it("writes recap_model when set", () => {
		writeConfig(
			makeConfig({
				claude: {
					model: "claude-sonnet-4-6",
					effort: "high",
					permission_mode: "default",
					turn_recaps: true,
					interactive_mode: false,
					recap_model: "claude-sonnet-4-6",
				},
			}),
		);
		expect(capturedToml()).toContain('recap_model = "claude-sonnet-4-6"');
	});

	it("omits recap_model when undefined", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).not.toContain("recap_model");
	});
});

// ── agents all fields ─────────────────────────────────────────────────────────

describe("writeConfig — agents all provider fields", () => {
	it("writes model, effort, max_turns, permission_mode when set", () => {
		writeConfig(
			makeConfig({
				agents: [
					{
						path: "/agents/bot",
						mode: "cwd",
						provider: "claude",
						model: "claude-opus-4-7",
						effort: "max",
						max_turns: 5,
						permission_mode: "bypassPermissions",
					},
				],
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain('model = "claude-opus-4-7"');
		expect(toml).toContain('effort = "max"');
		expect(toml).toContain("max_turns = 5");
		expect(toml).toContain('permission_mode = "bypassPermissions"');
	});

	it("omits model/effort/max_turns/permission_mode when not set", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "cwd", provider: "claude" }],
			}),
		);
		const agents = capturedToml().slice(capturedToml().indexOf("[[agents]]"));
		expect(agents).not.toMatch(/^model\s*=/m);
		expect(agents).not.toMatch(/^effort\s*=/m);
		expect(agents).not.toMatch(/^max_turns\s*=/m);
		expect(agents).not.toMatch(/^permission_mode\s*=/m);
	});

	it("writes mode when not default (cwd)", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "context", provider: "claude" }],
			}),
		);
		expect(capturedToml()).toContain('mode = "context"');
	});

	it("omits mode when cwd (default)", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "cwd", provider: "claude" }],
			}),
		);
		const agents = capturedToml().slice(capturedToml().indexOf("[[agents]]"));
		expect(agents).not.toMatch(/^mode\s*=/m);
	});

	it("writes provider when not claude (default)", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "cwd", provider: "openai" }],
			}),
		);
		expect(capturedToml()).toContain('provider = "openai"');
	});

	it("omits provider when claude (default)", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "cwd", provider: "claude" }],
			}),
		);
		const agents = capturedToml().slice(capturedToml().indexOf("[[agents]]"));
		expect(agents).not.toMatch(/^provider\s*=/m);
	});

	it("roundtrips all agent fields", () => {
		writeConfig(
			makeConfig({
				agents: [
					{
						path: "/agents/full",
						name: "Full Bot",
						mode: "context",
						provider: "openai",
						model: "claude-haiku-4-5-20251001",
						effort: "low",
						max_turns: 3,
						permission_mode: "acceptEdits",
						recap_model: "claude-haiku-4-5-20251001",
					},
				],
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain('path = "/agents/full"');
		expect(toml).toContain('name = "Full Bot"');
		expect(toml).toContain('mode = "context"');
		expect(toml).toContain('provider = "openai"');
		expect(toml).toContain('model = "claude-haiku-4-5-20251001"');
		expect(toml).toContain('effort = "low"');
		expect(toml).toContain("max_turns = 3");
		expect(toml).toContain('permission_mode = "acceptEdits"');
		expect(toml).toContain('recap_model = "claude-haiku-4-5-20251001"');
	});
});

// ── agents recap_model ────────────────────────────────────────────────────────

describe("writeConfig — agents recap_model", () => {
	it("writes recap_model in agent block when set", () => {
		writeConfig(
			makeConfig({
				agents: [
					{
						path: "/agents/bot",
						mode: "cwd",
						provider: "claude",
						recap_model: "claude-haiku-4-5-20251001",
					},
				],
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain('recap_model = "claude-haiku-4-5-20251001"');
	});

	it("omits recap_model from agent block when not set", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/bot", mode: "cwd", provider: "claude" }],
			}),
		);
		const agentsSection = capturedToml().slice(
			capturedToml().indexOf("[[agents]]"),
		);
		expect(agentsSection).not.toContain("recap_model");
	});
});

// ── agents section ────────────────────────────────────────────────────────────

describe("writeConfig — agents section", () => {
	it("writes [[agents]] blocks for each agent", () => {
		writeConfig(
			makeConfig({
				agents: [
					{
						path: "/agents/bot-a",
						name: "Bot A",
						mode: "cwd",
						provider: "claude",
					},
					{ path: "/agents/bot-b", mode: "cwd", provider: "claude" },
				],
			}),
		);
		const toml = capturedToml();
		const agentBlocks = (toml.match(/\[\[agents\]\]/g) ?? []).length;
		expect(agentBlocks).toBe(2);
		expect(toml).toContain('path = "/agents/bot-a"');
		expect(toml).toContain('name = "Bot A"');
		expect(toml).toContain('path = "/agents/bot-b"');
	});

	it("omits name field when absent", () => {
		writeConfig(
			makeConfig({
				agents: [{ path: "/agents/anon", mode: "cwd", provider: "claude" }],
			}),
		);
		const toml = capturedToml();
		expect(toml).toContain("[[agents]]");
		// name line should not appear inside the agents block
		const agentsSection = toml.slice(toml.indexOf("[[agents]]"));
		expect(agentsSection).not.toMatch(/^name\s*=/m);
	});

	it("writes no [[agents]] block for empty agents array", () => {
		writeConfig(makeConfig({ agents: [] }));
		expect(capturedToml()).not.toContain("[[agents]]");
	});
});

// ── status_vocabulary section ─────────────────────────────────────────────────

describe("writeConfig — status_vocabulary section", () => {
	it("writes array values with TOML inline array syntax", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).toContain('active = ["Active", "In Progress"]');
		expect(toml).toContain('planning = ["Planning"]');
		expect(toml).toContain('done = ["Done"]');
	});
});
