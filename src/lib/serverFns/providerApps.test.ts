import { describe, expect, it } from "vitest";
import { providerAppsPath } from "./providerApps";

describe("provider Apps server functions", () => {
	it("builds one bounded provider-scoped inventory path", () => {
		expect(
			providerAppsPath({
				providerId: "codex",
				cwd: "/work/project",
				sessionId: "raven-1",
				cursor: "next page",
				limit: 50,
				refresh: true,
			}),
		).toBe(
			"/provider-apps?provider_id=codex&cwd=%2Fwork%2Fproject&session_id=raven-1&cursor=next+page&limit=50&refresh=1",
		);
	});
});
