import { describe, expect, it } from "vitest";
import { toAgentToolCallResult } from "./agentToolResult";

describe("agent tool result", () => {
	it("preserves text-only tool results", async () => {
		await expect(toAgentToolCallResult(async () => "done")).resolves.toEqual({
			content: [{ type: "text", text: "done" }],
		});
	});

	it("returns image content after textual provenance", async () => {
		await expect(
			toAgentToolCallResult(async () => ({
				text: '{"viewport":"mobile"}',
				images: [{ data: "AQID", mimeType: "image/png" }],
			})),
		).resolves.toEqual({
			content: [
				{ type: "text", text: '{"viewport":"mobile"}' },
				{ type: "image", data: "AQID", mimeType: "image/png" },
			],
		});
	});
});
