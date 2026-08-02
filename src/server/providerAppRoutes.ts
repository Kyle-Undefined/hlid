import { posix, win32 } from "node:path";
import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";

type ProviderAppRouteDependencies = {
	getProvider: (providerId: string) => AgentProvider | undefined;
	loadConfig: () => HlidConfig;
	onAuthenticationStarted?: () => void;
};

function boundedId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const clean = value.trim();
	if (!clean || clean.length > 240 || /[\0\r\n]/.test(clean)) return null;
	return clean;
}

function boundedCwd(value: string | null, fallback: string): string | null {
	const clean = (value ?? fallback).trim();
	if (
		!clean ||
		clean.length > 4_096 ||
		(!posix.isAbsolute(clean) && !win32.isAbsolute(clean))
	) {
		return null;
	}
	return clean;
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 300);
}

async function readProviderApps(
	url: URL,
	dependencies: ProviderAppRouteDependencies,
): Promise<Response> {
	const providerId = boundedId(url.searchParams.get("provider_id"));
	if (!providerId) {
		return Response.json({ error: "provider_id is required" }, { status: 400 });
	}
	const provider = dependencies.getProvider(providerId);
	if (!provider) {
		return Response.json({ error: "Provider was not found" }, { status: 404 });
	}
	if (!provider.listApps) {
		return Response.json(
			{ error: "This provider does not expose an Apps catalog through Hlid" },
			{ status: 409 },
		);
	}
	const config = dependencies.loadConfig();
	const cwd = boundedCwd(
		url.searchParams.get("cwd"),
		config.vault.path || process.cwd(),
	);
	if (!cwd) {
		return Response.json(
			{ error: "cwd must be an absolute path" },
			{ status: 400 },
		);
	}
	const rawLimit = Number(url.searchParams.get("limit") ?? "50");
	if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
		return Response.json(
			{ error: "limit must be an integer from 1 to 100" },
			{ status: 400 },
		);
	}
	const cursor = url.searchParams.get("cursor")?.trim();
	if (cursor && (cursor.length > 500 || /[\0\r\n]/.test(cursor))) {
		return Response.json({ error: "cursor is invalid" }, { status: 400 });
	}
	const sessionId = boundedId(url.searchParams.get("session_id"));
	if (url.searchParams.has("session_id") && !sessionId) {
		return Response.json({ error: "session_id is invalid" }, { status: 400 });
	}
	try {
		return Response.json(
			await provider.listApps({
				cwd,
				...(sessionId ? { sessionId } : {}),
				limit: rawLimit,
				...(cursor ? { cursor } : {}),
				...(url.searchParams.get("refresh") === "1" ? { refresh: true } : {}),
			}),
		);
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 409 });
	}
}

async function authenticateProviderApp(
	request: Request,
	dependencies: ProviderAppRouteDependencies,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		providerId?: unknown;
		cwd?: unknown;
		kind?: unknown;
		id?: unknown;
	} | null;
	const providerId = boundedId(body?.providerId);
	const id = boundedId(body?.id);
	if (!providerId || !id || (body?.kind !== "app" && body?.kind !== "mcp")) {
		return Response.json(
			{ error: "providerId, kind, and id are required" },
			{ status: 400 },
		);
	}
	const provider = dependencies.getProvider(providerId);
	if (!provider) {
		return Response.json({ error: "Provider was not found" }, { status: 404 });
	}
	if (!provider.startAppAuthentication) {
		return Response.json(
			{
				error: "This provider does not expose app authentication through Hlid",
			},
			{ status: 409 },
		);
	}
	const config = dependencies.loadConfig();
	const cwd = boundedCwd(
		typeof body.cwd === "string" ? body.cwd : null,
		config.vault.path || process.cwd(),
	);
	if (!cwd) {
		return Response.json(
			{ error: "cwd must be an absolute path" },
			{ status: 400 },
		);
	}
	try {
		const result = await provider.startAppAuthentication({
			cwd,
			target: { kind: body.kind, id },
		});
		dependencies.onAuthenticationStarted?.();
		return Response.json({ ok: result.opened });
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 409 });
	}
}

export function createProviderAppRouteHandler(
	dependencies: ProviderAppRouteDependencies,
) {
	return async (url: URL, request: Request): Promise<Response | null> => {
		if (url.pathname === "/provider-apps" && request.method === "GET") {
			return readProviderApps(url, dependencies);
		}
		if (
			url.pathname === "/provider-apps/authenticate" &&
			request.method === "POST"
		) {
			return authenticateProviderApp(request, dependencies);
		}
		return null;
	};
}
