import { describe, expect, it } from "vitest";
import {
	INTERNAL_OBSIDIAN_MCP_FLAG,
	obsidianMcpProcessCommand,
} from "./obsidianMcpServer";

describe("Obsidian MCP process", () => {
	it("relaunches the current development entrypoint as an internal MCP server", () => {
		const argv = process.argv;
		process.argv = [process.execPath, "/work/hlid/src/server/index.ts"];
		try {
			expect(obsidianMcpProcessCommand()).toEqual({
				command: process.execPath,
				args: ["/work/hlid/src/server/index.ts", INTERNAL_OBSIDIAN_MCP_FLAG],
				env: [{ name: "HLID_SKIP_SELF_INSTALL", value: "1" }],
			});
		} finally {
			process.argv = argv;
		}
	});
});
