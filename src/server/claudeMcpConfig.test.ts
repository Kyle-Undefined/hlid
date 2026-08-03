import { describe, expect, it } from "vitest";
import { prepareClaudeMcpServers } from "./claudeMcpConfig";

describe("prepareClaudeMcpServers", () => {
	it("keeps enabled stdio and remote definitions in the dynamic set", () => {
		const prepared = prepareClaudeMcpServers([
			{
				name: "local",
				config: {
					command: "bun",
					args: ["server.ts"],
					env: { TOKEN: "secret" },
					timeout: 2_000,
				},
				disabled: false,
			},
			{
				name: "remote",
				config: {
					type: "http",
					url: "https://example.com/mcp",
					headers: { Authorization: "Bearer token" },
				},
				disabled: false,
			},
		]);

		expect(prepared.managedNames).toEqual(["local", "remote"]);
		expect(prepared.dynamicServers).toEqual({
			local: {
				command: "bun",
				args: ["server.ts"],
				env: { TOKEN: "secret" },
				timeout: 2_000,
			},
			remote: {
				type: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer token" },
			},
		});
		expect(prepared.errors).toEqual({});
	});

	it("isolates disabled, invalid, and Hlid-reserved definitions", () => {
		const prepared = prepareClaudeMcpServers(
			[
				{
					name: "disabled",
					config: { command: "bun" },
					disabled: true,
				},
				{
					name: "broken",
					config: { type: "http", url: 42 },
					disabled: false,
				},
				{
					name: "hlid",
					config: { command: "fake" },
					disabled: false,
				},
			],
			new Set(["hlid"]),
		);

		expect(prepared.managedNames).toEqual(["disabled", "broken", "hlid"]);
		expect(prepared.dynamicServers).toEqual({});
		expect(prepared.disabledNames).toEqual(["disabled"]);
		expect(prepared.errors).toEqual({
			broken: "http configuration requires a URL",
			hlid: "This MCP server name is reserved by Hlid",
		});
	});

	it("rejects malformed transport fields before they reach the SDK", () => {
		const prepared = prepareClaudeMcpServers([
			{
				name: "bad-args",
				config: { command: "bun", args: ["ok", 1] },
				disabled: false,
			},
			{
				name: "bad-headers",
				config: {
					type: "sse",
					url: "https://example.com/sse",
					headers: { Authorization: 1 },
				},
				disabled: false,
			},
		]);

		expect(prepared.dynamicServers).toEqual({});
		expect(prepared.errors).toEqual({
			"bad-args": "stdio args must be an array of strings",
			"bad-headers": "sse headers must contain only string values",
		});
	});
});
