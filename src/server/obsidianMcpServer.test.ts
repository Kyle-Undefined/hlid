import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	closeInternalMcpOnInputEnd,
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

	it("closes the MCP transport when its stdio client disconnects", async () => {
		const input = new EventEmitter();
		const close = vi.fn(async () => {});
		const stopWatching = closeInternalMcpOnInputEnd({ close }, input);

		input.emit("end");
		input.emit("close");
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

		stopWatching();
		expect(input.listenerCount("end")).toBe(0);
		expect(input.listenerCount("close")).toBe(0);
	});
});
