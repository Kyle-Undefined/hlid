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
	it("rejects an ACP-backed vault in a different distro even when an agent workspace matches", () => {
		const result = HlidConfigSchema.safeParse({
			vault: { name: "Fornbok", path: DEBIAN_WORKSPACE },
			vault_provider: "acp:opencode",
			agents: [{ path: UBUNTU_WORKSPACE, provider: "claude" }],
			acp_agents: [wslOpenCodeTarget()],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: ["vault", "path"] }),
			]),
		);
	});

	it("rejects an ACP-backed agent in a different distro even when the vault matches", () => {
		const result = HlidConfigSchema.safeParse({
			vault: { name: "Fornbok", path: UBUNTU_WORKSPACE },
			agents: [{ path: DEBIAN_WORKSPACE, provider: "acp:opencode" }],
			acp_agents: [wslOpenCodeTarget()],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: ["agents", 0, "path"] }),
			]),
		);
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
