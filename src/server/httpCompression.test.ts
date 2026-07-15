import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressHttpResponse } from "./httpCompression";

function request(
	acceptEncoding?: string,
	init: Omit<RequestInit, "headers"> & { headers?: HeadersInit } = {},
): Request {
	const headers = new Headers(init.headers);
	if (acceptEncoding !== undefined) {
		headers.set("accept-encoding", acceptEncoding);
	}
	return new Request("http://localhost/test", { ...init, headers });
}

async function decompressedText(response: Response): Promise<string> {
	return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}

describe("compressHttpResponse", () => {
	it("streams gzip for accepted textual responses and fixes representation headers", async () => {
		const body = "compressible response ".repeat(100);
		const response = new Response(body, {
			status: 201,
			statusText: "Created here",
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-length": String(body.length),
				"accept-ranges": "bytes",
				digest: "sha-256=legacy-digest",
				"content-digest": "sha-256=:content-digest:",
				"repr-digest": "sha-256=:representation-digest:",
				etag: '"strong-tag"',
				vary: "Origin",
			},
		});

		const result = await compressHttpResponse(
			request("br, gzip;q=0.8"),
			response,
		);

		expect(result.status).toBe(201);
		expect(result.statusText).toBe("Created here");
		expect(result.headers.get("content-encoding")).toBe("gzip");
		expect(result.headers.get("content-length")).toBeNull();
		expect(result.headers.get("accept-ranges")).toBeNull();
		expect(result.headers.get("digest")).toBeNull();
		expect(result.headers.get("content-digest")).toBeNull();
		expect(result.headers.get("repr-digest")).toBe(
			"sha-256=:representation-digest:",
		);
		expect(result.headers.get("etag")).toBe('W/"strong-tag"');
		expect(result.headers.get("vary")).toBe("Origin, Accept-Encoding");
		expect(await decompressedText(result)).toBe(body);
	});

	it("skips known bodies below 1 KiB while compressing at the threshold", async () => {
		const small = new Response("small", {
			headers: {
				"content-type": "application/json",
				"content-length": "5",
			},
		});
		expect(await compressHttpResponse(request("gzip"), small)).toBe(small);

		const thresholdBody = "x".repeat(1_024);
		const threshold = await compressHttpResponse(
			request("gzip"),
			new Response(thresholdBody, {
				headers: {
					"content-type": "text/plain",
					"content-length": String(thresholdBody.length),
				},
			}),
		);
		expect(threshold.headers.get("content-encoding")).toBe("gzip");
		expect(await decompressedText(threshold)).toBe(thresholdBody);
	});

	it("supports wildcard negotiation but lets an explicit gzip exclusion win", async () => {
		const wildcard = await compressHttpResponse(
			request("*;q=0.5"),
			new Response("hello", { headers: { "content-type": "text/plain" } }),
		);
		expect(wildcard.headers.get("content-encoding")).toBeNull();
		expect(wildcard.headers.get("content-length")).toBe("5");
		expect(await wildcard.text()).toBe("hello");

		const excluded = await compressHttpResponse(
			request("*;q=1, gzip;q=0"),
			new Response("identity", {
				headers: { "content-type": "text/plain" },
			}),
		);
		expect(excluded.headers.get("content-encoding")).toBeNull();
		expect(excluded.headers.get("vary")).toBe("Accept-Encoding");
		expect(await excluded.text()).toBe("identity");
	});

	it("probes unknown-length bodies without buffering the complete large stream", async () => {
		const body = JSON.stringify({ messages: ["history".repeat(300)] });
		const result = await compressHttpResponse(
			request("gzip"),
			new Response(body, { headers: { "content-type": "application/json" } }),
		);

		expect(result.headers.get("content-encoding")).toBe("gzip");
		expect(await decompressedText(result)).toBe(body);
	});

	it("marks eligible identity responses as varying without duplicating Vary", async () => {
		const result = await compressHttpResponse(
			request(),
			new Response("hello", {
				headers: {
					"content-type": "text/html",
					vary: "Origin, accept-encoding",
				},
			}),
		);
		expect(result.headers.get("content-encoding")).toBeNull();
		expect(result.headers.get("vary")).toBe("Origin, accept-encoding");
		expect(await result.text()).toBe("hello");
	});

	it.each([
		["binary media", request("gzip"), { "content-type": "image/png" }, 200],
		[
			"server-sent events",
			request("gzip"),
			{ "content-type": "text/event-stream" },
			200,
		],
		[
			"existing encoding",
			request("gzip"),
			{ "content-type": "text/plain", "content-encoding": "br" },
			200,
		],
		[
			"response no-transform",
			request("gzip"),
			{
				"content-type": "text/plain",
				"cache-control": "private, no-transform",
			},
			200,
		],
		[
			"request no-transform",
			request("gzip", { headers: { "cache-control": "no-transform" } }),
			{ "content-type": "text/plain" },
			200,
		],
		[
			"range request",
			request("gzip", { headers: { range: "bytes=0-10" } }),
			{ "content-type": "text/plain" },
			200,
		],
		[
			"partial response",
			request("gzip"),
			{ "content-type": "text/plain", "content-range": "bytes 0-1/4" },
			206,
		],
	] as const)("leaves %s untouched", async (_name, req, headers, status) => {
		const response = new Response("body", { headers, status });
		const result = await compressHttpResponse(req, response);
		expect(result).toBe(response);
	});

	it("does not transform HEAD or bodyless status responses", async () => {
		const head = new Response("body", {
			headers: { "content-type": "text/plain" },
		});
		expect(
			await compressHttpResponse(request("gzip", { method: "HEAD" }), head),
		).toBe(head);

		const bodyless = new Response(null, {
			status: 204,
			headers: { "content-type": "text/plain" },
		});
		expect(await compressHttpResponse(request("gzip"), bodyless)).toBe(
			bodyless,
		);
	});
});
