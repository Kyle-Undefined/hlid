import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/serverFns/config", () => ({
	getConfig: vi.fn(async () => ({ server: { port: 3000 } })),
}));
vi.mock("./token", () => ({ loadToken: vi.fn(() => "test-token") }));

import {
	dbJson,
	type InternalApiError,
	requireDbOk,
	resetDbClientForTesting,
} from "./dbClient";

describe("internal API client", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		resetDbClientForTesting();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns successful JSON and sends the internal token", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ value: 42 }));
		await expect(dbJson("/db/value", { value: 0 })).resolves.toEqual({
			value: 42,
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:3001/db/value");
		expect(new Headers(init?.headers).get("x-hlid-internal")).toBe(
			"test-token",
		);
		expect(new Headers(init?.headers).get("x-hlid-request-id")).toMatch(
			/^[0-9a-f-]{36}$/,
		);
	});

	it.each([
		["HTTP failure", () => new Response("down", { status: 503 })],
		["malformed JSON", () => new Response("not-json")],
	])("returns the fallback and reports %s", async (_label, response) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(response());
		await expect(
			dbJson("/db/failing?session_id=private", { value: 0 }),
		).resolves.toEqual({
			value: 0,
		});
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("[internal-api] /db/failing unavailable"),
		);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/after \d+ms/));
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/\(request [0-9a-f-]{12}\)/),
		);
		expect(warn.mock.calls[0][0]).not.toContain("private");
	});

	it("deduplicates repeated soft-failure logs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
		await dbJson("/db/repeated", null);
		await dbJson("/db/repeated", null);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("requires mutation responses to succeed", async () => {
		const ok = Response.json({ ok: true });
		await expect(requireDbOk(ok, "save item")).resolves.toBe(ok);

		const failed = new Response("database is locked", { status: 500 });
		await expect(requireDbOk(failed, "save item")).rejects.toEqual(
			expect.objectContaining<Partial<InternalApiError>>({
				name: "InternalApiError",
				status: 500,
				message: expect.stringContaining("database is locked"),
			}),
		);
	});
});
