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
