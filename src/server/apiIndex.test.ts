import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, buildApiIndex } from "./apiIndex";

function endpoint(method: string, path: string) {
	const match = API_ENDPOINTS.find(
		(entry) => entry.method === method && entry.path === path,
	);
	expect(match, `${method} ${path}`).toBeDefined();
	return match;
}

describe("buildApiIndex", () => {
	it("carries the ports and the full endpoint catalog", () => {
		const index = buildApiIndex(3001, 3000);
		expect(index.api_port).toBe(3001);
		expect(index.ui_port).toBe(3000);
		expect(index.endpoints).toBe(API_ENDPOINTS);
		expect(index.endpoints.length).toBeGreaterThan(0);
	});

	it("has unique method+path entries", () => {
		const keys = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("lists itself so agents can rediscover the catalog", () => {
		expect(
			API_ENDPOINTS.some((e) => e.path === "/api-index" && e.method === "GET"),
		).toBe(true);
	});

	it("documents the current filter and pagination contracts for user-visible database routes", () => {
		const sessions = endpoint(
			"GET",
			"/db/sessions?page=&size=&q=&agent=&model=&provider=&stop=&archived=&range=&from=&to=&sort=",
		);
		expect(sessions?.desc).toContain("archived=1 or true");
		expect(sessions?.desc).toContain("today|7d|30d|90d|all|custom");

		const messages = endpoint(
			"GET",
			"/db/session-messages?session_id=&before_seq=&before_id=&min_seq=&min_id=&limit=&tool_event_page_size=",
		);
		expect(messages?.desc).toContain("before_seq/before_id");
		expect(messages?.desc).toContain("min_seq/min_id");

		const sessionUpdate = endpoint("PATCH", "/db/session?id=");
		expect(sessionUpdate?.desc).toContain('{"archived": boolean}');
		expect(sessionUpdate?.desc).toContain("cannot be archived");

		const cleanup = endpoint("POST", "/db/sessions/cleanup?older_than_days=");
		expect(cleanup?.desc).toContain("active, non-imported sessions");
		expect(cleanup?.desc).toContain("protected delegation lineages");
		expect(cleanup?.desc).toContain("cleanup/preview");
		expect(cleanup?.desc).toContain('{"older_than_days": number}');
		const cleanupPreview = endpoint(
			"GET",
			"/db/sessions/cleanup/preview?older_than_days=",
		);
		expect(cleanupPreview?.desc).toContain("preserved usage-query totals");
		expect(cleanupPreview?.desc).toContain("protected delegation lineages");

		const attachments = endpoint(
			"GET",
			"/db/attachments?kind=&category=&retention=&session_id=&search=&type=&since=&until=&sort=&dir=&limit=&offset=",
		);
		expect(attachments?.desc).toContain("ephemeral|vault");
		expect(attachments?.desc).toContain("limit is 1–500");

		const analytics = endpoint(
			"GET",
			"/db/ledger-analytics?range=&agent=&provider=&model=&from=&to=",
		);
		expect(analytics?.desc).toContain("custom requires YYYY-MM-DD from and to");

		const logs = endpoint("GET", "/db/logs?page=&size=&level=");
		expect(logs?.desc).toContain("level is all|error|warn|info");
		expect(logs?.desc).toContain("size is 1–200");
	});

	it("documents discovery, mutation, update, and config access contracts", () => {
		const index = buildApiIndex(3001, 3000);
		expect(index.description).toContain("Tailscale peers");
		expect(index.description).toContain("authenticated session");
		expect(index.description).toContain("Non-GET/HEAD");

		const status = endpoint("GET", "/status");
		expect(status?.desc).toContain("permission mode");
		expect(status?.desc).toContain("active turn ID");

		const providers = endpoint(
			"GET",
			"/providers?refresh=1&host_capabilities=1&provider_capabilities=1",
		);
		expect(providers?.desc).toContain("60-second");
		expect(providers?.desc).toContain("host_capabilities=1");
		expect(providers?.desc).toContain("provider_capabilities=1");

		const mcp = endpoint("GET", "/mcp-status");
		expect(mcp?.desc).toContain("currently selected provider");

		const extensions = endpoint("GET", "/extensions/catalog?refresh=1");
		expect(extensions?.desc).toContain("five seconds");
		const mutate = endpoint("POST", "/extensions/mutate");
		for (const action of [
			"install",
			"update",
			"uninstall",
			"set_enabled",
			"add_marketplace",
			"upgrade_marketplace",
			"remove_marketplace",
		]) {
			expect(mutate?.desc).toContain(action);
		}
		expect(mutate?.desc).toContain("environment IDs");

		const skillImport = endpoint("POST", "/skills/import");
		expect(skillImport?.desc).toContain("configured-agent-discovered");
		expect(skillImport?.desc).toContain("1 to 100");

		const updateRead = endpoint("GET", "/api/updates");
		expect(updateRead?.desc).toContain("background");
		const updateWrite = endpoint("POST", "/api/updates");
		expect(updateWrite?.desc).toContain("authenticated Tailscale");
		expect(updateWrite?.desc).not.toContain("loopback-only");

		const configRead = endpoint("GET", "/api/config");
		expect(configRead?.desc).toContain("__HLID_SECRET_SET__");
		const configWrite = endpoint("POST", "/api/config");
		expect(configWrite?.desc).toContain("not a partial patch");
		expect(configWrite?.desc).toContain("synchronize immediately");
	});

	it("includes the supported agent-facing inspection and management routes", () => {
		const routes = [
			["GET", "/skills/managed/content?id="],
			["POST", "/skills/refresh"],
			["GET", "/voice?refresh=1"],
			["POST", "/voice/sync"],
			["POST", "/voice/download"],
			["POST", "/voice/download/cancel"],
			["DELETE", "/voice/model?model="],
			["GET", "/db/session-context?session_id=&limit=&before_seq="],
			["GET", "/db/session-tool-event?session_id=&tool_id="],
			["POST", "/db/session/fork"],
			["POST", "/db/provider-history/import"],
			["GET", "/db/provider-history/import/status?job_id="],
			["GET", "/db/storage"],
			["POST", "/db/storage/optimize"],
			["GET", "/db/sessions/cleanup/preview?older_than_days="],
			["POST", "/api/agents"],
			["GET", "/api/agents/validate?path="],
			["GET", "/api/agents/claudemd?path="],
			["GET", "/api/mcp/vault"],
			["POST", "/api/mcp/vault"],
			["POST", "/api/mcp/vault/toggle"],
			["POST", "/api/mcp/agent/toggle"],
		] as const;
		for (const [method, path] of routes) endpoint(method, path);
		expect(
			API_ENDPOINTS.some(
				(entry) =>
					entry.method === "POST" && entry.path === "/db/storage/reclaim",
			),
		).toBe(false);

		expect(
			endpoint("GET", "/db/session-context?session_id=&limit=&before_seq=")
				?.desc,
		).toContain("context-receipt history");
		expect(endpoint("POST", "/db/session/fork")?.desc).toContain(
			"through-message capability",
		);
		expect(endpoint("POST", "/api/agents")?.desc).toContain("complete");
		expect(endpoint("POST", "/api/mcp/vault/toggle")?.desc).toContain(
			"disabled",
		);
	});

	it("describes orchestration progress, partial results, and resume admission", () => {
		const endpoint = (path: string) =>
			API_ENDPOINTS.find((entry) => entry.path === path)?.desc ?? "";
		expect(endpoint("/hlid-agents/:id?parent_session_id=")).toContain(
			"bounded active progress",
		);
		expect(endpoint("/hlid-agents/:id/wait")).toContain("partial result");
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"live running parent turn",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"active-capacity admission",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain("service_tier");
		expect(endpoint("/hlid-agents/delegate")).not.toContain(
			"model service_tier",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain("exact configured cwd");
		expect(endpoint("/hlid-agents/delegate")).toContain("recorded passively");
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"cross-provider silence is not proof of failure",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"never transition automatically to timed_out",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"Provider availability is checked before launch",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"explicit cancellation stops work",
		);
		expect(endpoint("/hlid-agents/delegate")).toContain(
			"Scheduled Routines may delegate",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"recorded configured workspace",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain("service tier");
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"passive observations",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain(
			"no elapsed-time or inactivity cap",
		);
		expect(endpoint("/hlid-agents/:id/resume")).toContain("non-Routine child");
		expect(endpoint("/hlid-agents/:id/cancel")).toContain(
			"retains provider control",
		);
		expect(endpoint("/hlid-agents/:id/cancel")).toContain(
			"until each provider turn settles",
		);
	});

	it("routes ui-server paths under /api/", () => {
		for (const e of API_ENDPOINTS) {
			if (e.server === "ui") expect(e.path.startsWith("/api/")).toBe(true);
		}
	});
});
