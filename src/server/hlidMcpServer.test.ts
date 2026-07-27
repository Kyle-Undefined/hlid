import { describe, expect, it } from "vitest";
import { hlidMcpProcessCommand, INTERNAL_HLID_MCP_FLAG } from "./hlidMcpServer";

describe("Hlid MCP process", () => {
	it("passes provider context into the host-owned MCP process", () => {
		const argv = process.argv;
		process.argv = [process.execPath, "/work/hlid/src/server/index.ts"];
		try {
			expect(
				hlidMcpProcessCommand({
					providerId: "acp:opencode",
					model: "gpt-test",
					effort: "high",
					permissionMode: "default",
					policyEnforced: true,
					runtimeCwd: "/work/project",
					sessionId: "session-1",
					vaultName: "Fornbok",
					agentMode: "cwd",
				}),
			).toEqual({
				command: process.execPath,
				args: ["/work/hlid/src/server/index.ts", INTERNAL_HLID_MCP_FLAG],
				env: [
					{ name: "HLID_SKIP_SELF_INSTALL", value: "1" },
					{
						name: "HLID_INTERNAL_MCP_RUNTIME_CWD",
						value: "/work/project",
					},
					{
						name: "HLID_INTERNAL_MCP_SESSION_ID",
						value: "session-1",
					},
					{
						name: "HLID_INTERNAL_MCP_PROVIDER_ID",
						value: "acp:opencode",
					},
					{ name: "HLID_INTERNAL_MCP_MODEL", value: "gpt-test" },
					{ name: "HLID_INTERNAL_MCP_EFFORT", value: "high" },
					{
						name: "HLID_INTERNAL_MCP_PERMISSION_MODE",
						value: "default",
					},
					{
						name: "HLID_INTERNAL_MCP_POLICY_ENFORCED",
						value: "true",
					},
					{ name: "HLID_INTERNAL_MCP_VAULT_NAME", value: "Fornbok" },
					{ name: "HLID_INTERNAL_MCP_AGENT_MODE", value: "cwd" },
				],
			});
		} finally {
			process.argv = argv;
		}
	});
});
