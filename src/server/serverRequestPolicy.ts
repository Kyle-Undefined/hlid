type RouteHandler = (
	url: URL,
	request: Request,
) => Response | null | undefined | Promise<Response | null | undefined>;

export function createAuthenticatedRouteHandler(operations: {
	getStatus: () => unknown;
	getApiIndex: () => unknown;
	orderedHandlers: RouteHandler[];
	getMcpStatus: () => unknown;
	handleDb: RouteHandler;
	handleAttachment: RouteHandler;
}) {
	return async (url: URL, request: Request): Promise<Response> => {
		if (url.pathname === "/status") {
			return Response.json(operations.getStatus());
		}
		if (url.pathname === "/api-index" && request.method === "GET") {
			return Response.json(operations.getApiIndex());
		}
		for (const handler of operations.orderedHandlers) {
			const response = await handler(url, request);
			if (response) return response;
		}
		if (url.pathname === "/mcp-status" && request.method === "GET") {
			return Response.json(operations.getMcpStatus());
		}
		const dbResponse = await operations.handleDb(url, request);
		if (dbResponse) return dbResponse;
		const attachmentResponse = await operations.handleAttachment(url, request);
		if (attachmentResponse) return attachmentResponse;
		return new Response("Not found", { status: 404 });
	};
}

export function createServerRequestPolicy<Context>(operations: {
	isPeerAllowed: (peerIp: string | undefined) => boolean;
	isMutationOriginAllowed: (origin: string | null) => boolean;
	handleWebSocket: (
		request: Request,
		url: URL,
		peerIp: string | undefined,
		context: Context,
	) => Response | null | undefined | Promise<Response | null | undefined>;
	authorize: (request: Request, peerIp: string | undefined) => Promise<boolean>;
	handleAuthenticated: (url: URL, request: Request) => Promise<Response>;
}) {
	return async (
		request: Request,
		peerIp: string | undefined,
		context: Context,
	): Promise<Response | undefined> => {
		const url = new URL(request.url);
		if (!operations.isPeerAllowed(peerIp)) {
			return new Response("Forbidden", { status: 403 });
		}
		if (
			request.method !== "GET" &&
			request.method !== "HEAD" &&
			!operations.isMutationOriginAllowed(request.headers.get("origin"))
		) {
			return new Response("Forbidden", { status: 403 });
		}
		const websocketResponse = await operations.handleWebSocket(
			request,
			url,
			peerIp,
			context,
		);
		if (websocketResponse !== null) return websocketResponse;
		if (!(await operations.authorize(request, peerIp))) {
			return Response.json(
				{ error: "Unauthorized" },
				{ status: 401, headers: { "cache-control": "no-store" } },
			);
		}
		return operations.handleAuthenticated(url, request);
	};
}
