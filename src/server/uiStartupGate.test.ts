import { beforeEach, describe, expect, it } from "vitest";
import {
	markUiServerReady,
	resetUiServerReadyForTesting,
	uiStartupGateResponse,
} from "./uiStartupGate";

beforeEach(resetUiServerReadyForTesting);

describe("UI startup gate", () => {
	it("serves a self-refreshing splash for document navigation", async () => {
		const response = uiStartupGateResponse(
			new Request("http://localhost/ledger?tab=sessions", {
				headers: { accept: "text/html,application/xhtml+xml" },
			}),
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		const html = await response?.text();
		expect(html).toContain("Starting system");
		expect(html).toContain("fetch('/api/health'");
		expect(html).toContain("location.reload()");
	});

	it("reports starting until the system is marked ready", async () => {
		const request = new Request("http://localhost/api/health");
		const starting = uiStartupGateResponse(request);
		expect(starting?.status).toBe(503);
		expect(await starting?.json()).toEqual({
			service: "hlid",
			status: "starting",
		});

		markUiServerReady();
		expect(uiStartupGateResponse(request)).toBeNull();
	});

	it("does not block asset or server-function traffic", () => {
		expect(
			uiStartupGateResponse(new Request("http://localhost/assets/app.js")),
		).toBeNull();
		expect(
			uiStartupGateResponse(
				new Request("http://localhost/", {
					headers: { accept: "text/html", "x-tsr-serverfn": "true" },
				}),
			),
		).toBeNull();
	});
});
