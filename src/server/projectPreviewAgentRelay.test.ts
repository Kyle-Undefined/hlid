import { describe, expect, it } from "vitest";
import {
	projectPreviewAgentRelayBootstrap,
	projectPreviewAgentRelayUpstreamCookies,
} from "./projectPreviewAgentRelay";
import { PROJECT_PREVIEW_AUTH_HEADER } from "./projectPreviewTrust";

describe("Project Preview agent relay", () => {
	it("keeps relay credentials out of the injected browser bootstrap", () => {
		const bootstrap = projectPreviewAgentRelayBootstrap();

		expect(bootstrap).toContain("/__hlid_backend__");
		expect(bootstrap).toContain("Service workers are disabled");
		expect(bootstrap).not.toContain(PROJECT_PREVIEW_AUTH_HEADER);
		expect(bootstrap).not.toContain("HLID_PROJECT_PREVIEW_AUTH_TOKEN");
	});

	it("removes every private relay cookie before forwarding app cookies", () => {
		expect(
			projectPreviewAgentRelayUpstreamCookies(
				"app_session=visible; __hlid_agent_preview_old=secret; theme=dark",
			),
		).toBe("app_session=visible; theme=dark");
		expect(
			projectPreviewAgentRelayUpstreamCookies(
				"__hlid_agent_preview_only=secret",
			),
		).toBeNull();
	});
});
