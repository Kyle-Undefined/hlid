/**
 * writeConfig — verifies TOML serialization output.
 * Mocks writeFileSync and syncWrappers; inspects captured string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	renameSync: vi.fn(),
	rmSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("../server/wrappers", () => ({
	syncWrappers: vi.fn(),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import { renameSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { type HlidConfig, HlidConfigSchema } from "../config";
import { serializeConfig, writeConfig } from "./config-writer";
import {
	isEventLogPersistenceEnabled,
	setEventLogPersistenceEnabled,
} from "./eventLogPolicy";
import { builtInThemePalette } from "./theme";

const mockWrite = vi.mocked(writeFileSync);
const mockRename = vi.mocked(renameSync);

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
		diagnostics: { event_log: true },
		claude: {
			model: "claude-sonnet-4-6",
			effort: "high",
			permission_mode: "default",
			turn_recaps: true,
			agent_progress_summaries: false,
			interactive_mode: false,
			peer_inbox: false,
		},
		ui: {
			enter_to_submit: true,
			live_sessions_hotkey: "Alt+Shift+KeyS",
			hide_skills_index: true,
			show_provider_entries: false,
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
	mockRename.mockClear();
	setEventLogPersistenceEnabled(true);
});

describe("writeConfig — persistence invariants", () => {
	it("round-trips every schema field, including attachment policy", () => {
		const config = HlidConfigSchema.parse({
			diagnostics: { event_log: false },
			vault: {
				name: "Round trip",
				path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\Fornbok",
				style: "wiki",
				save_to_obsidian_template: "Quick Capture",
				obsidian_command_allowlist: ["templater-obsidian:insert-templater"],
				delete_vault_attachments: true,
			},
			attachments: {
				max_bytes: 123456,
				allowed_mimes: ["image/png", "application/x-custom"],
			},
			codex: {
				windows_computer_use: { model: "gpt-5.5", effort: "high" },
			},
			project_preview: { use_real_browser_profile: true },
			cliproxy: {
				enabled: true,
				base_url: "http://127.0.0.1:8317",
				api_key: "sidecar-key",
				model: "gpt-5.6-sol",
				effort: "xhigh",
				max_turns: 20,
				permission_mode: "acceptEdits",
				turn_recaps: false,
				recap_model: "gpt-5.6-luna",
			},
			auto_sleep: {
				enabled: true,
				threshold: 0.8,
				max_sleep_minutes: 120,
				resume_buffer_seconds: 30,
			},
			ui: {
				navigation_names: {
					preset: "plain",
					labels: { einherjar: "Team Space", raven: "Conversation Hub" },
				},
			},
			agents: [{ path: "/agent", interactive_mode: false }],
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
					executable: "/opt/opencode",
					args: ["acp"],
					env: { API_URL: "https://example.test:8443/path" },
					model_filter: {
						mode: "only",
						models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.6-luna"],
					},
					model: "anthropic/claude-sonnet-4-6",
					effort: "high",
					permission_mode: "default",
					turn_recaps: false,
					recap_model: "openai/gpt-5.6-luna",
				},
			],
		});

		const reparsed = HlidConfigSchema.parse(parse(serializeConfig(config)));
		expect(reparsed).toEqual(config);
	});

	it("keeps Event Log persistence on by default and serializes an explicit opt-out", () => {
		expect(HlidConfigSchema.parse({}).diagnostics.event_log).toBe(true);
		const disabled = HlidConfigSchema.parse({
			diagnostics: { event_log: false },
		});
		const serialized = serializeConfig(disabled);

		expect(serialized).toContain("[diagnostics]\nevent_log = false");
		expect(
			HlidConfigSchema.parse(parse(serialized)).diagnostics.event_log,
		).toBe(false);
	});

	it("applies Event Log persistence live after the atomic config write", () => {
		const disabled = HlidConfigSchema.parse({
			diagnostics: { event_log: false },
		});

		writeConfig(disabled);

		expect(isEventLogPersistenceEnabled()).toBe(false);
		expect(mockRename).toHaveBeenCalledOnce();
	});

	it("defaults, normalizes, and strips unknown navigation label keys", () => {
		expect(HlidConfigSchema.parse({}).ui.navigation_names).toEqual({
			preset: "plain",
			labels: {},
		});

		const config = HlidConfigSchema.parse({
			ui: {
				navigation_names: {
					preset: "plain",
					labels: {
						einherjar: "  Team   Space  ",
						future_destination: "Future",
					},
				},
			},
		});

		expect(config.ui.navigation_names).toEqual({
			preset: "plain",
			labels: { einherjar: "Team Space" },
		});
	});

	it("rejects unsafe, oversized, and duplicate navigation labels", () => {
		for (const navigationNames of [
			{ preset: "unknown", labels: {} },
			{ preset: "hlid", labels: { watch: "   " } },
			{ preset: "hlid", labels: { watch: "Bad\nLabel" } },
			{ preset: "hlid", labels: { watch: "\u202eBad" } },
			{ preset: "hlid", labels: { watch: "\u200c\u200d" } },
			{ preset: "hlid", labels: { watch: "a".repeat(25) } },
			{
				preset: "hlid",
				labels: { watch: "Same destination", vault: "same DESTINATION" },
			},
			{ preset: "hlid", labels: { watch: "vault" } },
		]) {
			expect(
				HlidConfigSchema.safeParse({
					ui: { navigation_names: navigationNames },
				}).success,
			).toBe(false);
		}
	});

	it("writes navigation names as a nested UI table and omits absent overrides", () => {
		const config = HlidConfigSchema.parse({
			ui: {
				navigation_names: {
					preset: "plain",
					labels: { einherjar: "Team Space" },
				},
			},
		});
		const serialized = serializeConfig(config);
		const navigationSection = serialized.slice(
			serialized.indexOf("[ui.navigation_names]"),
			serialized.indexOf("[status_vocabulary]"),
		);

		expect(navigationSection).toContain('preset = "plain"');
		expect(navigationSection).toContain('einherjar = "Team Space"');
		expect(navigationSection).not.toMatch(/^watch\s*=/m);
		expect(
			HlidConfigSchema.parse(parse(serialized)).ui.navigation_names,
		).toEqual(config.ui.navigation_names);
	});

	it("validates bounded OpenCode filters and every persisted model override", () => {
		expect(
			HlidConfigSchema.safeParse({
				acp_agents: [
					{ id: "opencode", env: { TOKEN: "first" } },
					{ id: "opencode", env: { TOKEN: "second" } },
				],
			}).success,
		).toBe(false);
		for (const modelFilter of [
			{ mode: "hide", models: [] },
			{
				mode: "only",
				models: ["opencode/model-a", "opencode/model-a"],
			},
			{ mode: "hide", models: ["__proto__/model-a"] },
			{ mode: "hide", models: ["constructor/model-a"] },
			{ mode: "hide", models: ["prototype/model-a"] },
		] as const) {
			expect(
				HlidConfigSchema.safeParse({
					acp_agents: [{ id: "opencode", model_filter: modelFilter }],
				}).success,
			).toBe(false);
		}

		const result = HlidConfigSchema.safeParse({
			acp_agents: [
				{
					id: "opencode",
					model: "opencode/model-hidden",
					recap_model: "opencode/recap-hidden",
					model_filter: {
						mode: "hide",
						models: ["opencode/model-hidden", "opencode/recap-hidden"],
					},
				},
			],
			agents: [
				{
					path: "/agent",
					provider: "acp:opencode",
					model: "opencode/model-hidden",
					recap_model: "opencode/recap-hidden",
				},
			],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues.map((issue) => issue.path)).toEqual(
			expect.arrayContaining([
				["acp_agents", 0, "model"],
				["acp_agents", 0, "recap_model"],
				["agents", 0, "model"],
				["agents", 0, "recap_model"],
			]),
		);
	});

	it("requires an ACP WSL target to match an exact configured workspace distro", () => {
		expect(
			HlidConfigSchema.safeParse({
				vault: {
					name: "Fornbok",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\Fornbok",
				},
				acp_agents: [
					{ id: "opencode", target: { kind: "wsl", distro: "Debian" } },
				],
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				vault: {
					name: "Fornbok",
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\Fornbok",
				},
				acp_agents: [
					{
						id: "opencode",
						target: { kind: "wsl", distro: "ubuntu-24.04" },
					},
				],
			}).success,
		).toBe(true);
	});

	it("round-trips an optional Codex permission profile and omits the default", () => {
		const configured = HlidConfigSchema.parse({
			codex: { permission_profile: "workspace-safe" },
		});
		const serialized = serializeConfig(configured);
		expect(serialized).toContain('permission_profile = "workspace-safe"');
		expect(
			HlidConfigSchema.parse(parse(serialized)).codex.permission_profile,
		).toBe("workspace-safe");

		expect(serializeConfig(HlidConfigSchema.parse({}))).not.toContain(
			"permission_profile",
		);
	});

	it("round-trips separate desktop and mobile custom palettes", () => {
		const config = HlidConfigSchema.parse({
			ui: {
				theme: "custom",
				mobile_theme: "custom",
				custom_theme: builtInThemePalette("dark"),
				mobile_custom_theme: builtInThemePalette("tan"),
			},
		});
		const parsed = HlidConfigSchema.parse(parse(serializeConfig(config)));
		expect(parsed.ui).toEqual(config.ui);
	});

	it("fills new Ledger colors when reading a legacy custom palette", () => {
		const legacyPalette: Record<string, unknown> = {
			...builtInThemePalette("tan"),
		};
		delete legacyPalette.token_input;
		delete legacyPalette.token_output;
		delete legacyPalette.cache_read;
		delete legacyPalette.cache_write;
		delete legacyPalette.status_info;
		const config = HlidConfigSchema.parse({
			ui: { theme: "custom", custom_theme: legacyPalette },
		});
		expect(config.ui.custom_theme).toMatchObject({
			token_input: "#8c4e35",
			token_output: "#ca8a04",
			cache_read: "#16a34a",
			cache_write: "#ea580c",
			status_info: "#8c4e35",
		});
	});

	it("writes to a private temporary file before atomically renaming it", () => {
		writeConfig(makeConfig());
		const temporaryPath = mockWrite.mock.calls[0][0] as string;
		expect(temporaryPath).toMatch(/hlid\.config\.toml\.\d+\.\d+\.tmp$/);
		expect(mockWrite.mock.calls[0][2]).toEqual({
			encoding: "utf-8",
			mode: 0o600,
		});
		expect(mockRename).toHaveBeenCalledWith(
			temporaryPath,
			expect.stringMatching(/hlid\.config\.toml$/),
		);
	});
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
		expect(toml).toContain("[project_preview]");
		expect(toml).toContain("use_real_browser_profile = false");
		expect(toml).toContain("[ui]");
		expect(toml).toContain("[ui.navigation_names]");
		expect(toml).toContain('preset = "plain"');
		expect(toml).toContain("[status_vocabulary]");
	});
});

describe("writeConfig — voice section", () => {
	it("writes the default desktop recording hotkey", () => {
		writeConfig(makeConfig());
		expect(capturedToml()).toContain('hotkey = "Alt+Shift+KeyV"');
	});

	it("writes acceleration, thread, and vocabulary settings", () => {
		const config = HlidConfigSchema.parse({
			voice: {
				acceleration: "cpu",
				threads: 8,
				vocabulary: ["Claude", "Codex", "Hlið"],
			},
		});
		writeConfig(config);
		const toml = capturedToml();
		expect(toml).toContain('acceleration = "cpu"');
		expect(toml).toContain("threads = 8");
		expect(toml).toContain('vocabulary = ["Claude", "Codex", "Hlið"]');
	});

	it("round-trips local neural pronunciation mappings as TOML inline tables", () => {
		const config = HlidConfigSchema.parse({
			voice: {
				pronunciations: [
					{ written: "Hlið", spoken: "hleeth" },
					{ written: "C++", spoken: "C plus plus" },
				],
			},
		});
		const toml = serializeConfig(config);

		expect(toml).toContain(
			'pronunciations = [{ "written" = "Hlið", "spoken" = "hleeth" }, { "written" = "C++", "spoken" = "C plus plus" }]',
		);
		expect(HlidConfigSchema.parse(parse(toml)).voice.pronunciations).toEqual(
			config.voice.pronunciations,
		);
	});

	it("writes shared read-aloud settings", () => {
		const config = HlidConfigSchema.parse({
			voice: {
				read_aloud_provider: "microsoft",
				read_aloud_voice: "voice-mark",
				read_aloud_rate: 1.25,
				tts_model: "kitten-nano-v0.8-int8",
				tts_voice: "expr-voice-5-f",
				tts_threads: 8,
				local_conversation_mode: true,
			},
		});
		writeConfig(config);
		const toml = capturedToml();
		expect(toml).toContain('read_aloud_provider = "microsoft"');
		expect(toml).toContain('read_aloud_voice = "voice-mark"');
		expect(toml).toContain("read_aloud_rate = 1.25");
		expect(toml).toContain('tts_model = "kitten-nano-v0.8-int8"');
		expect(toml).toContain('tts_voice = "expr-voice-5-f"');
		expect(toml).toContain("tts_threads = 8");
		expect(toml).toContain("local_conversation_mode = true");
	});

	it("preserves Talk to Codex while migrating legacy Codex read aloud", () => {
		const config = HlidConfigSchema.parse({
			voice: {
				input_provider: "codex",
				read_aloud_provider: "codex",
				codex_voice: "cedar",
				codex_live_mode: true,
			},
		});
		writeConfig(config);
		const toml = capturedToml();
		expect(toml).toContain('input_provider = "codex"');
		expect(toml).toContain('read_aloud_provider = "device"');
		expect(toml).toContain('codex_voice = "cedar"');
		expect(toml).toContain("codex_live_mode = true");
	});

	it("round-trips Codex realtime dictation without changing the default", () => {
		const config = HlidConfigSchema.parse({
			voice: {
				input_provider: "codex_dictation",
				codex_live_mode: true,
			},
		});
		const toml = serializeConfig(config);
		expect(toml).toContain('input_provider = "codex_dictation"');
		expect(HlidConfigSchema.parse(parse(toml)).voice.input_provider).toBe(
			"codex_dictation",
		);
		expect(HlidConfigSchema.parse({ voice: {} }).voice.input_provider).toBe(
			"local",
		);
	});

	it("allows the recording hotkey to be cleared", () => {
		writeConfig(
			makeConfig({
				voice: {
					enabled: true,
					input_provider: "local",
					model: "base",
					language: "auto",
					auto_send: false,
					read_aloud_provider: "device",
					read_aloud_voice: "",
					read_aloud_rate: 1,
					tts_model: "",
					tts_voice: "expr-voice-2-f",
					tts_threads: 4,
					local_conversation_mode: false,
					codex_voice: "marin",
					codex_live_mode: false,
					hotkey: "",
					max_recording_seconds: 300,
					acceleration: "auto",
					threads: 4,
					pronunciations: [],
					vocabulary: ["Claude", "Codex"],
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
					save_to_obsidian_template: "Quick Capture",
					obsidian_command_allowlist: ["templater-obsidian:insert-templater"],
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
		expect(toml).toContain('save_to_obsidian_template = "Quick Capture"');
		expect(toml).toContain(
			'obsidian_command_allowlist = ["templater-obsidian:insert-templater"]',
		);
		expect(toml).toContain("delete_vault_attachments = false");
	});

	it("omits optional vault fields when absent", () => {
		writeConfig(makeConfig());
		const toml = capturedToml();
		expect(toml).not.toMatch(/^inbox\s*=/m);
		expect(toml).not.toMatch(/^projects\s*=/m);
		expect(toml).not.toMatch(/^style\s*=/m);
		expect(toml).not.toMatch(/^save_to_obsidian_template\s*=/m);
		expect(toml).not.toMatch(/^obsidian_command_allowlist\s*=/m);
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
					agent_progress_summaries: false,
					interactive_mode: false,
					peer_inbox: false,
				},
			}),
		);
		expect(capturedToml()).toContain("turn_recaps = false");
	});

	it("writes the Claude peer inbox only after opt-in", () => {
		expect(serializeConfig(makeConfig())).not.toContain("peer_inbox");
		const config = HlidConfigSchema.parse({ claude: { peer_inbox: true } });
		const serialized = serializeConfig(config);
		expect(serialized).toContain("peer_inbox = true");
		expect(HlidConfigSchema.parse(parse(serialized)).claude.peer_inbox).toBe(
			true,
		);
	});

	it("writes Claude AI subagent summaries only after opt-in", () => {
		expect(serializeConfig(makeConfig())).not.toContain(
			"agent_progress_summaries",
		);
		const config = HlidConfigSchema.parse({
			claude: { agent_progress_summaries: true },
		});
		const serialized = serializeConfig(config);
		expect(serialized).toContain("agent_progress_summaries = true");
		expect(
			HlidConfigSchema.parse(parse(serialized)).claude.agent_progress_summaries,
		).toBe(true);
	});

	it("writes max_turns when set", () => {
		writeConfig(
			makeConfig({
				claude: {
					model: "m",
					effort: "low",
					permission_mode: "default",
					turn_recaps: true,
					agent_progress_summaries: false,
					interactive_mode: false,
					peer_inbox: false,
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
					agent_progress_summaries: false,
					interactive_mode: false,
					peer_inbox: false,
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

	it("omits an unmapped max_turns value for ACP directory agents", () => {
		writeConfig(
			makeConfig({
				agents: [
					{
						path: "/agents/acp",
						mode: "cwd",
						provider: "acp:opencode",
						max_turns: 5,
					},
				],
			}),
		);
		const agents = capturedToml().slice(capturedToml().indexOf("[[agents]]"));
		expect(agents).not.toMatch(/^max_turns\s*=/m);
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
