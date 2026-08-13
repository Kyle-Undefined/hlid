import { describe, expect, it } from "vitest";
import { HlidConfigSchema } from "./config";

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
