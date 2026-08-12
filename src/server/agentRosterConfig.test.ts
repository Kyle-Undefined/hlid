import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "#/config";
import { saveAgentRosterConfig } from "./agentRosterConfig";

describe("saveAgentRosterConfig", () => {
	it("preserves private ACP environment values and synchronizes runtime", async () => {
		const current = HlidConfigSchema.parse({
			agents: [{ path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\old" }],
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
					env: { TOKEN: "real-secret" },
				},
			],
		});
		const write = vi.fn();
		const syncAcp = vi.fn(async () => new Response());
		await saveAgentRosterConfig(
			[
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\new",
					mode: "cwd",
					provider: "claude",
				},
			],
			{
				load: () => current,
				write,
				syncAcp,
				warn: vi.fn(),
			},
		);

		expect(write).toHaveBeenCalledWith(
			expect.objectContaining({
				acp_agents: [
					expect.objectContaining({ env: { TOKEN: "real-secret" } }),
				],
			}),
		);
		expect(syncAcp).toHaveBeenCalledOnce();
	});

	it("rejects orphaning an exact ACP WSL target before writing", async () => {
		const current = HlidConfigSchema.parse({
			agents: [{ path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\old" }],
			acp_agents: [
				{
					id: "opencode",
					target: { kind: "wsl", distro: "Ubuntu-24.04" },
				},
			],
		});
		const write = vi.fn();
		await expect(
			saveAgentRosterConfig([], {
				load: () => current,
				write,
				syncAcp: vi.fn(),
				warn: vi.fn(),
			}),
		).rejects.toThrow(
			/must match the configured vault or an exact agent workspace/,
		);
		expect(write).not.toHaveBeenCalled();
	});
});
