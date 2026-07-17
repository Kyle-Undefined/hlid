import { afterEach, describe, expect, it, vi } from "vitest";
import { safeRequestPath } from "../lib/httpDiagnostics";
import {
	createRequestObserver,
	safeErrorSummary,
	startEventLoopLagMonitor,
} from "./requestDiagnostics";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("request diagnostics", () => {
	it("keeps only a sanitized route label", () => {
		expect(
			safeRequestPath(
				"https://hlid.test/api/attachments/019f67e1-33b3-70f3-ad41-dafeed1d745e/raw?token=secret",
			),
		).toBe("/api/attachments/:id/raw");
		expect(safeRequestPath("not a valid url")).toBe("/:id");
	});

	it("scrubs causes before retaining them", () => {
		const summary = safeErrorSummary(
			new Error(
				"failed at C:\\Users\\kyle\\secret.txt for https://example.test/private session 019f67e1-33b3-70f3-ad41-dafeed1d745e",
			),
		);
		expect(summary).toContain("<path>");
		expect(summary).toContain("<url>");
		expect(summary).toContain("<id>");
		expect(summary).not.toContain("secret.txt");
	});

	it("reports slow and failed requests with a correlation id", async () => {
		let now = 0;
		const log = vi.fn();
		const observe = createRequestObserver({
			scope: "internal-api",
			slowRequestMs: 1_000,
			now: () => now,
			log,
		});
		const slowRequest = new Request(
			"http://localhost/db/provider-usage?providers=private",
			{ headers: { "x-hlid-request-id": "019f67e1-33b3-70f3-ad41" } },
		);
		await observe(slowRequest, () => {
			now = 1_250;
			return new Response("ok");
		});
		expect(log).toHaveBeenCalledWith(
			"warn",
			"[internal-api] GET /db/provider-usage request 019f67e1-33b completed in 1250ms with 200",
		);

		now = 40_000;
		await observe(
			new Request("http://localhost/db/stats"),
			() => new Response("down", { status: 503 }),
		);
		expect(log).toHaveBeenLastCalledWith(
			"error",
			"[internal-api] GET /db/stats returned 503 after 0ms",
		);
	});

	it("deduplicates a repeated signature and rethrows handler failures", async () => {
		let now = 0;
		const log = vi.fn();
		const observe = createRequestObserver({
			scope: "ui",
			now: () => now,
			log,
		});
		const request = new Request("http://localhost/raven?session=private", {
			headers: { "x-hlid-request-id": "aaaaaaaa-aaaa" },
		});
		const failure = () => {
			throw new Error("render failed");
		};
		await expect(observe(request, failure)).rejects.toThrow("render failed");
		now = 1_000;
		await expect(
			observe(
				new Request("http://localhost/raven?session=other", {
					headers: { "x-hlid-request-id": "bbbbbbbb-bbbb" },
				}),
				failure,
			),
		).rejects.toThrow("render failed");
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			"error",
			"[ui] GET /raven request aaaaaaaa-aaa failed after 0ms: Error: render failed",
		);
	});
});

describe("event-loop lag monitor", () => {
	it("reports a real stall once per cooldown and ignores system sleep", () => {
		vi.useFakeTimers();
		let now = 0;
		const log = vi.fn();
		const stop = startEventLoopLagMonitor({
			intervalMs: 250,
			warningThresholdMs: 750,
			cooldownMs: 30_000,
			maxReportableLagMs: 30_000,
			now: () => now,
			log,
		});

		now = 1_250;
		vi.advanceTimersByTime(250);
		expect(log).toHaveBeenCalledWith("[server] event loop delayed by 1000ms");

		now = 2_500;
		vi.advanceTimersByTime(250);
		expect(log).toHaveBeenCalledTimes(1);

		now = 60_000;
		vi.advanceTimersByTime(250);
		expect(log).toHaveBeenCalledTimes(1);

		now = 61_250;
		vi.advanceTimersByTime(250);
		expect(log).toHaveBeenCalledTimes(2);
		stop();
	});
});
