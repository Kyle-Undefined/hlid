import { describe, expect, it } from "vitest";
import {
	PROVIDER_APPS_READ_TIMEOUT_MS,
	providerAppsPath,
} from "./providerApps";

describe("provider Apps server functions", () => {
	it("keeps the catalog read below the UI server request timeout", () => {
		expect(PROVIDER_APPS_READ_TIMEOUT_MS).toBe(8_000);
		expect(PROVIDER_APPS_READ_TIMEOUT_MS).toBeLessThan(10_000);
	});

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
