import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { forbiddenResponse } from "#/lib/originGate";
import { loadToken } from "#/lib/token";
import {
	authState,
	changePassword,
	clearSessionCookie,
	createInitialPassword,
	createSession,
	effectivePeerIp,
	isLoopback,
	isSecureRequest,
	loginRetryAfterSeconds,
	readCookie,
	revokeAllSessions,
	revokeSession,
	sessionCookie,
	verifyLogin,
} from "#/server/auth";
import { readRequestBodyLimited } from "#/server/requestLimits";

const MAX_AUTH_BODY_BYTES = 2 * 1024;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store", ...headers },
	});
}

async function bodyJson(request: Request): Promise<unknown> {
	const result = await readRequestBodyLimited(request, MAX_AUTH_BODY_BYTES);
	if (!result.ok) throw result.response;
	try {
		return JSON.parse(new TextDecoder().decode(result.body));
	} catch {
		throw new Error("Invalid JSON body");
	}
}

async function bodyPassword(request: Request): Promise<string> {
	const body = (await bodyJson(request)) as { password?: unknown };
	return typeof body.password === "string" ? body.password : "";
}

function errorResponse(error: unknown, fallback: string): Response {
	if (error instanceof Response) return error;
	return json(
		{ error: error instanceof Error ? error.message : fallback },
		400,
	);
}

async function authenticatedResponse(
	request: Request,
	secure: boolean,
): Promise<Response> {
	const token = await createSession(
		request.headers.get("user-agent") ?? undefined,
	);
	return json({ ok: true }, 200, {
		"set-cookie": sessionCookie(token, secure),
	});
}

async function setupResponse(
	request: Request,
	peerIp: string,
	secure: boolean,
): Promise<Response> {
	if (!isLoopback(peerIp)) {
		return json({ error: "Initial setup requires the Hlid machine" }, 403);
	}
	try {
		await createInitialPassword(await bodyPassword(request));
		return await authenticatedResponse(request, secure);
	} catch (error) {
		return errorResponse(error, "Setup failed");
	}
}

function rateLimitResponse(peerIp: string): Response | null {
	const retryAfter = loginRetryAfterSeconds(peerIp);
	if (retryAfter <= 0) return null;
	return json({ error: "Too many attempts. Try again later." }, 429, {
		"retry-after": String(retryAfter),
	});
}

async function loginResponse(
	request: Request,
	peerIp: string,
	secure: boolean,
): Promise<Response> {
	if (!isLoopback(peerIp) && !secure) {
		return json({ error: "Remote login requires HTTPS" }, 400);
	}
	const limited = rateLimitResponse(peerIp);
	if (limited) return limited;
	let password: string;
	try {
		password = await bodyPassword(request);
	} catch (error) {
		return errorResponse(error, "Invalid request");
	}
	if (!(await verifyLogin(password, peerIp))) {
		return json({ error: "Invalid password" }, 401);
	}
	return authenticatedResponse(request, secure);
}

async function changePasswordResponse(
	request: Request,
	peerIp: string,
	secure: boolean,
): Promise<Response> {
	const limited = rateLimitResponse(peerIp);
	if (limited) return limited;
	try {
		const body = (await bodyJson(request)) as {
			currentPassword?: unknown;
			newPassword?: unknown;
		};
		const currentPassword =
			typeof body.currentPassword === "string" ? body.currentPassword : "";
		const newPassword =
			typeof body.newPassword === "string" ? body.newPassword : "";
		if (!(await changePassword(currentPassword, newPassword, peerIp))) {
			return json({ error: "Invalid current password" }, 401);
		}
		return json({ ok: true }, 200, {
			"set-cookie": clearSessionCookie(secure),
		});
	} catch (error) {
		return errorResponse(error, "Password change failed");
	}
}

async function authenticatedActionResponse(
	action: string,
	request: Request,
	peerIp: string,
	secure: boolean,
): Promise<Response> {
	switch (action) {
		case "logout":
			await revokeSession(readCookie(request));
			break;
		case "revoke-all":
			await revokeAllSessions();
			break;
		case "change-password":
			return changePasswordResponse(request, peerIp, secure);
		default:
			return json({ error: "Not found" }, 404);
	}
	return json({ ok: true }, 200, {
		"set-cookie": clearSessionCookie(secure),
	});
}

export const Route = createFileRoute("/api/auth/$action")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				if (params.action !== "status")
					return json({ error: "Not found" }, 404);
				const { ui } = (await import("#/server/config")).loadConfig();
				return json({
					state: await authState(request),
					theme: ui.theme,
					mobileTheme: ui.mobile_theme,
				});
			},
			POST: async ({ request, params }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				const directPeerIp = getRequestIP();
				const peerIp =
					effectivePeerIp(request, directPeerIp, loadToken()) ?? "";
				const secure = isSecureRequest(request, directPeerIp);

				if (params.action === "setup")
					return setupResponse(request, peerIp, secure);

				if (params.action === "login")
					return loginResponse(request, peerIp, secure);

				if ((await authState(request)) !== "authenticated") {
					return json({ error: "Unauthorized" }, 401);
				}

				return authenticatedActionResponse(
					params.action,
					request,
					peerIp,
					secure,
				);
			},
		},
	},
});
