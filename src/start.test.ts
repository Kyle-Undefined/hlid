import { csrfSymbol } from "@tanstack/react-start";
import { describe, expect, it, vi } from "vitest";
import { startInstance } from "./start";

type RequestMiddleware = {
	options: {
		server: (context: {
			request: Request;
			pathname: string;
			handlerType: "router" | "serverFn";
			context: Record<string, never>;
			next: () => Promise<{
				request: Request;
				pathname: string;
				context: Record<string, never>;
				response: Response;
			}>;
		}) => Promise<Response | { response: Response }>;
	};
};

async function csrfBoundary() {
	const options = await startInstance.getOptions();
	const middleware =
		options.requestMiddleware as unknown as RequestMiddleware[];
	expect(middleware).toHaveLength(2);
	expect(csrfSymbol in middleware[0]).toBe(false);
	expect(csrfSymbol in middleware[1]).toBe(true);
	return middleware[1];
}

async function runCsrfBoundary(
	request: Request,
	handlerType: "router" | "serverFn" = "serverFn",
) {
	const middleware = await csrfBoundary();
	const pathname = new URL(request.url).pathname;
	const allowed = new Response("allowed");
	const next = vi.fn(async () => ({
		request,
		pathname,
		context: {},
		response: allowed,
	}));
	const result = await middleware.options.server({
		request,
		pathname,
		handlerType,
		context: {},
		next,
	});
	return {
		next,
		response: result instanceof Response ? result : result.response,
	};
}

function serverFnRequest(
	url: string,
	headers: Record<string, string>,
): Request {
	return new Request(url, { method: "POST", headers });
}

describe("TanStack server function CSRF boundary", () => {
	it.each([
		{
			name: "direct loopback",
			url: "http://127.0.0.1:3000/_serverFn/example",
			origin: "http://127.0.0.1:3000",
		},
		{
			name: "direct Tailscale TLS",
			url: "https://host.tailnet.ts.net/_serverFn/example",
			origin: "https://host.tailnet.ts.net",
		},
		{
			name: "compiled TLS proxy",
			url: "http://127.0.0.1:3000/_serverFn/example",
			origin: "https://host.tailnet.ts.net",
		},
		{
			name: "Project Preview relay target",
			url: "http://127.0.0.1:4179/_serverFn/example",
			origin: "http://127.0.0.1:4179",
		},
	])("allows $name browser requests", async ({ url, origin }) => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest(url, {
				origin,
				"sec-fetch-site": "same-origin",
			}),
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
	});

	it("allows an exact-origin fallback when Fetch Metadata is unavailable", async () => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest("http://127.0.0.1:3000/_serverFn/example", {
				origin: "http://127.0.0.1:3000",
			}),
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
	});

	it("rejects a same-site server function request from another loopback port", async () => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest("http://127.0.0.1:3000/_serverFn/example", {
				origin: "http://127.0.0.1:4173",
				"sec-fetch-site": "same-site",
			}),
		);

		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("rejects a cross-port Origin fallback without Fetch Metadata", async () => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest("http://127.0.0.1:3000/_serverFn/example", {
				origin: "http://127.0.0.1:4173",
			}),
		);

		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("rejects server function requests without verifiable browser origin metadata", async () => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest("http://127.0.0.1:3000/_serverFn/example", {}),
		);

		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("leaves ordinary router requests to the existing Hlid security boundary", async () => {
		const { next, response } = await runCsrfBoundary(
			serverFnRequest("http://127.0.0.1:3000/raven", {
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			}),
			"router",
		);

		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
	});
});
