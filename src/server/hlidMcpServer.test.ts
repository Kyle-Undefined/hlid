import { describe, expect, it } from "vitest";
import { hlidMcpProcessCommand, INTERNAL_HLID_MCP_FLAG } from "./hlidMcpServer";

describe("Hlid MCP process", () => {
	it("passes provider context into the host-owned MCP process", () => {
		const argv = process.argv;
		process.argv = [process.execPath, "/work/hlid/src/server/index.ts"];
		try {
			expect(
				hlidMcpProcessCommand({
					runtimeCwd: "/work/project",
					sessionId: "session-1",
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
				],
			});
		} finally {
			process.argv = argv;
		}
	});
});
