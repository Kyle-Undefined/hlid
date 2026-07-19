import { describe, expect, it } from "vitest";
import { type McpRegistryEntry, mergeMcpRegistry } from "./mcpRegistry";

const configured: McpRegistryEntry = {
	name: "github",
	providerId: "codex",
	status: "pending",
	scope: "agent",
	source: "agent",
};

describe("mergeMcpRegistry", () => {
	it("overlays live state while preserving the owning agent scope", () => {
		expect(
			mergeMcpRegistry([
				configured,
				{
					...configured,
					status: "connected",
					scope: "provider",
					source: "runtime",
				},
			]),
		).toEqual([
			{
				...configured,
				status: "connected",
				source: "runtime",
			},
		]);
	});

	it("keeps same-name servers separate by provider", () => {
		const rows = mergeMcpRegistry([
			configured,
			{ ...configured, providerId: "claude", scope: "vault", source: "vault" },
		]);
		expect(rows.map((row) => row.providerId)).toEqual(["claude", "codex"]);
	});

	it("uses provider discovery over compatibility-file pending state", () => {
		const [row] = mergeMcpRegistry([
			configured,
			{
				...configured,
				status: "needs-auth",
				scope: "provider",
				source: "provider",
			},
		]);
		expect(row.status).toBe("needs-auth");
		expect(row.scope).toBe("agent");
	});

	it("keeps an explicitly disabled scoped server disabled", () => {
		const [row] = mergeMcpRegistry([
			{ ...configured, status: "disabled" },
			{ ...configured, status: "connected", source: "runtime" },
		]);
		expect(row.status).toBe("disabled");
		expect(row.source).toBe("agent");
	});
});
