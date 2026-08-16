import { describe, expect, it, vi } from "vitest";
import {
	createOpenCodeGoUsageReader,
	OPENCODE_GO_USAGE_ENDPOINT,
	parseOpenCodeGoUsage,
} from "./openCodeGoUsage";

function usageBody(percent = 25) {
	return {
		usage: {
			rolling: {
				status: "ok",
				percent,
				resetsAt: "2030-01-01T01:00:00.000Z",
			},
			weekly: {
				status: "ok",
				percent: 50,
				resetsAt: "2030-01-07T00:00:00.000Z",
			},
			monthly: {
				status: "rate-limited",
				percent: 100,
				resetsAt: "2030-02-01T00:00:00.000Z",
			},
		},
	};
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("parseOpenCodeGoUsage", () => {
	it("maps the official rolling, weekly, and monthly payload", () => {
		expect(parseOpenCodeGoUsage(usageBody(125))).toEqual([
			{
				windowId: "opencode_go_rolling",
				label: "5-HOUR",
				utilization: 1,
				remaining: null,
				limit: null,
				resetsAt: 1_893_459_600,
			},
			{
				windowId: "opencode_go_weekly",
				label: "WEEKLY",
				utilization: 0.5,
				remaining: null,
				limit: null,
				resetsAt: 1_893_974_400,
			},
			{
				windowId: "opencode_go_monthly",
				label: "MONTHLY",
				utilization: 1,
				remaining: null,
				limit: null,
				resetsAt: 1_896_134_400,
			},
		]);
	});

	it.each([
		null,
		{},
		{ usage: {} },
		{ ...usageBody(), usage: { ...usageBody().usage, weekly: null } },
		{
			...usageBody(),
			usage: {
				...usageBody().usage,
				rolling: { ...usageBody().usage.rolling, percent: -1 },
			},
		},
	])("rejects a malformed or incomplete payload", (payload) => {
		expect(parseOpenCodeGoUsage(payload)).toBeNull();
	});
});

describe("createOpenCodeGoUsageReader", () => {
	it("sends the configured key only in the bearer header and caches for a minute", async () => {
		let now = 1_000_000;
		const fetchFn = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				jsonResponse(usageBody()),
		);
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			now: () => now,
		});

		await client();
		now += 30_000;
		await client();

		expect(fetchFn).toHaveBeenCalledOnce();
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(OPENCODE_GO_USAGE_ENDPOINT);
		expect(String(url)).not.toContain("go-secret");
		expect(init?.headers).toMatchObject({
			authorization: "Bearer go-secret",
		});
	});

	it("deduplicates concurrent refreshes", async () => {
		let resolveResponse: ((response: Response) => void) | undefined;
		const fetchFn = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
		});

		const first = client();
		const second = client();
		expect(fetchFn).toHaveBeenCalledOnce();
		resolveResponse?.(jsonResponse(usageBody()));
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});

	it.each([
		401, 403,
	])("clears readings and backs off after HTTP %s", async (status) => {
		let now = 1_000_000;
		const fetchFn = vi.fn(async () => jsonResponse({}, status));
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			now: () => now,
		});

		const readings = await client();
		expect(readings).toHaveLength(3);
		expect(readings.every((reading) => reading.utilization === null)).toBe(
			true,
		);
		now += 60_000;
		await client();
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("authoritatively clears a cached account after authentication is rejected", async () => {
		let now = 1_000_000;
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(usageBody(64)))
			.mockResolvedValueOnce(jsonResponse({}, 401));
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			now: () => now,
		});

		expect((await client())[0]?.utilization).toBe(0.64);
		now += 61_000;
		const cleared = await client();

		expect(cleared.every((reading) => reading.utilization === null)).toBe(true);
	});

	it("retains a recent reading and honors Retry-After on HTTP 429", async () => {
		let now = 1_000_000;
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(usageBody(20)))
			.mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "120" }));
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			now: () => now,
		});

		await client();
		now += 61_000;
		expect((await client())[0]?.utilization).toBe(0.2);
		now += 60_000;
		expect((await client())[0]?.utilization).toBe(0.2);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("retains transiently stale data only for the bounded stale interval", async () => {
		let now = 1_000_000;
		const fetchFn = vi
			.fn()
			.mockResolvedValue(jsonResponse({ usage: { rolling: {} } }))
			.mockResolvedValueOnce(jsonResponse(usageBody(31)));
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			now: () => now,
		});

		expect((await client())[0]?.utilization).toBe(0.31);
		now += 61_000;
		expect((await client())[0]?.utilization).toBe(0.31);
		now += 10 * 60_000;
		expect((await client())[0]?.utilization).toBeNull();
	});

	it("treats malformed JSON as unavailable without throwing", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ usage: { rolling: {} } }));
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
		});

		await expect(client()).resolves.toHaveLength(3);
		expect((await client())[0]?.utilization).toBeNull();
	});

	it("turns a timed-out request into a nonfatal unavailable reading", async () => {
		const fetchFn = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		const client = createOpenCodeGoUsageReader({
			apiKey: "go-secret",
			fetch: fetchFn,
			timeoutMs: 5,
		});

		await expect(client()).resolves.toHaveLength(3);
	});
});
