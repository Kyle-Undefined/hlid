import { describe, expect, it } from "vitest";
import {
	HlidConfigSchema,
	MAX_VOICE_PRONUNCIATION_LENGTH,
	MAX_VOICE_PRONUNCIATIONS,
} from "./config";

const UBUNTU_WORKSPACE =
	"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\workspace";
const DEBIAN_WORKSPACE = "\\\\wsl.localhost\\Debian\\home\\kyle\\workspace";

function wslOpenCodeTarget() {
	return {
		id: "opencode",
		target: { kind: "wsl" as const, distro: "Ubuntu-24.04" },
	};
}

describe("HlidConfigSchema interface view", () => {
	it("keeps existing configurations in Full view by default", () => {
		expect(HlidConfigSchema.parse({}).ui.view_mode).toBe("full");
	});

	it("accepts Simple view and rejects unknown presentation modes", () => {
		expect(
			HlidConfigSchema.parse({ ui: { view_mode: "simple" } }).ui.view_mode,
		).toBe("simple");
		expect(
			HlidConfigSchema.safeParse({ ui: { view_mode: "expert" } }).success,
		).toBe(false);
	});
});

describe("HlidConfigSchema ACP WSL workspace targets", () => {
	it("lets an ACP-backed vault select its own WSL distro independently of the Forge target", () => {
		const result = HlidConfigSchema.safeParse({
			vault: { name: "Fornbok", path: DEBIAN_WORKSPACE },
			vault_provider: "acp:opencode",
			agents: [{ path: UBUNTU_WORKSPACE, provider: "claude" }],
			acp_agents: [wslOpenCodeTarget()],
		});

		expect(result.success).toBe(true);
	});

	it("lets each ACP-backed agent select its exact WSL distro", () => {
		const result = HlidConfigSchema.safeParse({
			vault: { name: "Fornbok", path: UBUNTU_WORKSPACE },
			agents: [{ path: DEBIAN_WORKSPACE, provider: "acp:opencode" }],
			acp_agents: [wslOpenCodeTarget()],
		});

		expect(result.success).toBe(true);
	});

	it("accepts ACP-backed WSL paths in the provider target distro", () => {
		expect(
			HlidConfigSchema.safeParse({
				vault: { name: "Fornbok", path: UBUNTU_WORKSPACE },
				vault_provider: "acp:opencode",
				agents: [{ path: UBUNTU_WORKSPACE, provider: "acp:opencode" }],
				acp_agents: [wslOpenCodeTarget()],
			}).success,
		).toBe(true);
	});

	it("accepts native paths for ACP-backed vaults and agents", () => {
		expect(
			HlidConfigSchema.safeParse({
				vault: { name: "Fornbok", path: "C:\\Users\\kyle\\Fornbok" },
				vault_provider: "acp:opencode",
				agents: [
					{ path: "D:\\development\\project", provider: "acp:opencode" },
					{ path: UBUNTU_WORKSPACE, provider: "claude" },
				],
				acp_agents: [wslOpenCodeTarget()],
			}).success,
		).toBe(true);
	});
});

describe("HlidConfigSchema OpenCode Go usage", () => {
	it("requires an explicit configured key and remains OpenCode-only", () => {
		expect(
			HlidConfigSchema.safeParse({
				acp_agents: [{ id: "opencode", opencode_go_usage: { api_key: "" } }],
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				acp_agents: [
					{
						id: "other",
						opencode_go_usage: { api_key: "secret" },
					},
				],
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				acp_agents: [
					{
						id: "opencode",
						opencode_go_usage: { api_key: "secret" },
					},
				],
			}).success,
		).toBe(true);
	});
});

describe("HlidConfigSchema Windows Ollama models", () => {
	it("accepts a top-level integration independently from OpenCode", () => {
		const defaults = HlidConfigSchema.parse({
			ollama: { models: ["qwen3.5:27b", "library/coder:latest"] },
		}).ollama;
		expect(defaults).toEqual({
			models: ["qwen3.5:27b", "library/coder:latest"],
			keep_warm: "5m",
		});
		expect(
			HlidConfigSchema.parse({
				ollama: { models: ["qwen3.5:27b"], keep_warm: "session" },
			}).ollama?.keep_warm,
		).toBe("session");
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["qwen3.5:27b"], keep_warm: "forever" },
			}).success,
		).toBe(false);
	});

	it("rejects empty, duplicate, or unsafe model selections", () => {
		for (const models of [
			[],
			["qwen3.5:27b", "qwen3.5:27b"],
			["model with spaces"],
		] as string[][]) {
			expect(
				HlidConfigSchema.safeParse({
					ollama: { models },
				}).success,
			).toBe(false);
		}
	});

	it("hoists and strips the short-lived nested OpenCode shape", () => {
		const parsed = HlidConfigSchema.parse({
			acp_agents: [
				{
					id: "opencode",
					ollama: { models: ["qwen3.5:27b", "devstral:24b"] },
				},
			],
		});

		expect(parsed.ollama).toEqual({
			models: ["qwen3.5:27b", "devstral:24b"],
			keep_warm: "5m",
		});
		expect(parsed.acp_agents?.[0]).toEqual({ id: "opencode" });
		expect(parsed.acp_agents?.[0]).not.toHaveProperty("ollama");
	});

	it("accepts matching canonical and legacy sets but rejects conflicts", () => {
		const matching = HlidConfigSchema.parse({
			ollama: { models: ["qwen3.5:27b", "devstral:24b"] },
			acp_agents: [
				{
					id: "opencode",
					ollama: { models: ["devstral:24b", "qwen3.5:27b"] },
				},
			],
		});
		expect(matching.ollama?.models).toEqual(["qwen3.5:27b", "devstral:24b"]);
		expect(matching.acp_agents?.[0]).not.toHaveProperty("ollama");

		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["qwen3.5:27b"] },
				acp_agents: [
					{
						id: "opencode",
						ollama: { models: ["devstral:24b"] },
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects legacy nested Ollama config on non-OpenCode ACP agents", () => {
		expect(
			HlidConfigSchema.safeParse({
				acp_agents: [{ id: "other", ollama: { models: ["qwen3.5:27b"] } }],
			}).success,
		).toBe(false);
	});

	it("keeps selected Ollama models consistent with OpenCode visibility", () => {
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["qwen3.5:27b"] },
				acp_agents: [
					{
						id: "opencode",
						model_filter: {
							mode: "only",
							models: ["opencode/free"],
						},
					},
				],
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["qwen3.5:27b"] },
				acp_agents: [
					{
						id: "opencode",
						model_filter: {
							mode: "only",
							models: ["hlid-ollama/qwen3.5:27b"],
						},
					},
				],
			}).success,
		).toBe(true);
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["qwen3.5:27b"] },
				acp_agents: [
					{
						id: "opencode",
						model_filter: {
							mode: "hide",
							models: ["hlid-ollama/qwen3.5:27b"],
						},
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects unselected reserved Ollama IDs in OpenCode visibility", () => {
		for (const mode of ["only", "hide"] as const) {
			expect(
				HlidConfigSchema.safeParse({
					acp_agents: [
						{
							id: "opencode",
							model_filter: {
								mode,
								models: ["hlid-ollama/unselected:latest"],
							},
						},
					],
				}).success,
			).toBe(false);
			expect(
				HlidConfigSchema.safeParse({
					ollama: { models: ["selected:latest"] },
					acp_agents: [
						{
							id: "opencode",
							model_filter: {
								mode,
								models: ["hlid-ollama/unselected:latest"],
							},
						},
					],
				}).success,
			).toBe(false);
		}
	});

	it("requires Ollama defaults to remain in the selected Windows models", () => {
		for (const configured of [
			{ model: "hlid-ollama/missing:latest" },
			{ recap_model: "hlid-ollama/missing:latest" },
		]) {
			expect(
				HlidConfigSchema.safeParse({
					ollama: { models: ["selected:latest"] },
					acp_agents: [
						{
							id: "opencode",
							...configured,
						},
					],
				}).success,
			).toBe(false);
		}
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["selected:latest"] },
				acp_agents: [
					{
						id: "opencode",
						model: "hlid-ollama/selected:latest",
						recap_model: "hlid-ollama/selected:latest",
					},
				],
			}).success,
		).toBe(true);
	});

	it("requires per-workspace OpenCode defaults to remain selected", () => {
		expect(
			HlidConfigSchema.safeParse({
				ollama: { models: ["selected:latest"] },
				agents: [
					{
						path: "C:\\workspace",
						provider: "acp:opencode",
						model: "hlid-ollama/missing:latest",
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("HlidConfigSchema Local Conversation", () => {
	it("is opt-in and preserves an explicit enabled value", () => {
		expect(HlidConfigSchema.parse({}).voice.local_conversation_mode).toBe(
			false,
		);
		expect(
			HlidConfigSchema.parse({
				voice: { local_conversation_mode: true },
			}).voice.local_conversation_mode,
		).toBe(true);
	});
});

describe("HlidConfigSchema read-aloud pronunciations", () => {
	it("defaults to an empty library and trims literal written/spoken pairs", () => {
		expect(HlidConfigSchema.parse({}).voice.pronunciations).toEqual([]);
		expect(
			HlidConfigSchema.parse({
				voice: {
					pronunciations: [{ written: "  Hlið  ", spoken: "  hleeth  " }],
				},
			}).voice.pronunciations,
		).toEqual([{ written: "Hlið", spoken: "hleeth" }]);
	});

	it("rejects empty, oversized, or excessive pronunciation entries", () => {
		expect(
			HlidConfigSchema.safeParse({
				voice: { pronunciations: [{ written: "", spoken: "hleeth" }] },
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				voice: {
					pronunciations: [
						{
							written: "H".repeat(MAX_VOICE_PRONUNCIATION_LENGTH + 1),
							spoken: "aitch",
						},
					],
				},
			}).success,
		).toBe(false);
		expect(
			HlidConfigSchema.safeParse({
				voice: {
					pronunciations: Array.from(
						{ length: MAX_VOICE_PRONUNCIATIONS + 1 },
						(_, index) => ({
							written: `term ${index}`,
							spoken: `term ${index}`,
						}),
					),
				},
			}).success,
		).toBe(false);
	});

	it("keeps the first case-equivalent written pronunciation", () => {
		expect(
			HlidConfigSchema.parse({
				voice: {
					pronunciations: [
						{ written: " Hlið ", spoken: "first" },
						{ written: "HLIÐ", spoken: "second" },
						{ written: "Raven", spoken: "ray-ven" },
					],
				},
			}).voice.pronunciations,
		).toEqual([
			{ written: "Hlið", spoken: "first" },
			{ written: "Raven", spoken: "ray-ven" },
		]);
	});
});
