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

				if (params.action === "setup") {
					if (!isLoopback(peerIp)) {
						return json(
							{ error: "Initial setup requires the Hlid machine" },
							403,
						);
					}
					try {
						await createInitialPassword(await bodyPassword(request));
						const token = await createSession(
							request.headers.get("user-agent") ?? undefined,
						);
						return json({ ok: true }, 200, {
							"set-cookie": sessionCookie(token, secure),
						});
					} catch (error) {
						return errorResponse(error, "Setup failed");
					}
				}

				if (params.action === "login") {
					if (!isLoopback(peerIp) && !secure) {
						return json({ error: "Remote login requires HTTPS" }, 400);
					}
					const retryAfter = loginRetryAfterSeconds(peerIp);
					if (retryAfter > 0) {
						return json({ error: "Too many attempts. Try again later." }, 429, {
							"retry-after": String(retryAfter),
						});
					}
					let password = "";
					try {
						password = await bodyPassword(request);
					} catch (error) {
						return errorResponse(error, "Invalid request");
					}
					if (!(await verifyLogin(password, peerIp))) {
						return json({ error: "Invalid password" }, 401);
					}
					const token = await createSession(
						request.headers.get("user-agent") ?? undefined,
					);
					return json({ ok: true }, 200, {
						"set-cookie": sessionCookie(token, secure),
					});
				}

				if ((await authState(request)) !== "authenticated") {
					return json({ error: "Unauthorized" }, 401);
				}

				if (params.action === "logout") {
					await revokeSession(readCookie(request));
					return json({ ok: true }, 200, {
						"set-cookie": clearSessionCookie(secure),
					});
				}

				if (params.action === "revoke-all") {
					await revokeAllSessions();
					return json({ ok: true }, 200, {
						"set-cookie": clearSessionCookie(secure),
					});
				}

				if (params.action === "change-password") {
					const retryAfter = loginRetryAfterSeconds(peerIp);
					if (retryAfter > 0) {
						return json({ error: "Too many attempts. Try again later." }, 429, {
							"retry-after": String(retryAfter),
						});
					}
					try {
						const body = (await bodyJson(request)) as {
							currentPassword?: unknown;
							newPassword?: unknown;
						};
						const changed = await changePassword(
							typeof body.currentPassword === "string"
								? body.currentPassword
								: "",
							typeof body.newPassword === "string" ? body.newPassword : "",
							peerIp,
						);
						if (!changed)
							return json({ error: "Invalid current password" }, 401);
						return json({ ok: true }, 200, {
							"set-cookie": clearSessionCookie(secure),
						});
					} catch (error) {
						return errorResponse(error, "Password change failed");
					}
				}

				return json({ error: "Not found" }, 404);
			},
		},
	},
});
