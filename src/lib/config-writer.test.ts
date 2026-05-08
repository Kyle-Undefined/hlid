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
		expect(toml).toContain("[claude]");
		expect(toml).toContain("[ui]");
		expect(toml).toContain("[status_vocabulary]");
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
	it("writes model, effort, permission_mode", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).toContain('model = "claude-sonnet-4-6"');
		expect(toml).toContain('effort = "high"');
		expect(toml).toContain('permission_mode = "default"');
	});

	it("writes max_turns when set", () => {
		writeConfig(
			makeConfig({
				claude: {
					model: "m",
					effort: "low",
					permission_mode: "default",
					turn_recaps: true,
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
});

// ── agents section ────────────────────────────────────────────────────────────

describe("writeConfig — agents section", () => {
	it("writes [[agents]] blocks for each agent", () => {
		writeConfig(
			makeConfig({
				agents: [
					{ path: "/agents/bot-a", name: "Bot A", mode: "cwd" },
					{ path: "/agents/bot-b", mode: "cwd" },
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
				agents: [{ path: "/agents/anon", mode: "cwd" }],
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
