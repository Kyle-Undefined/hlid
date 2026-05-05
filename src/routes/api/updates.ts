import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { applyUpdate, downloadUpdate, getStatus } from "#/lib/updates";

const ACTIONS = ["check", "download", "apply"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(v: unknown): v is Action {
	return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

// In-flight POST guard. Two concurrent "apply"s would race on the staged
// exe and the spawn handoff. The cost of a second user click is real on
// FORGE: an action coalescing here is much cleaner than refunding the
// child process state after the fact.
let inFlight: Promise<unknown> | null = null;
async function single<T>(fn: () => Promise<T>): Promise<T> {
	if (inFlight) {
		throw new Error("update action already in progress");
	}
	const p = (async () => fn())();
	inFlight = p;
	try {
		return await p;
	} finally {
		inFlight = null;
	}
}

export const Route = createFileRoute("/api/updates")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				// Cache-only read: respects 24h TTL, only hits GitHub when stale.
				const status = await getStatus();
				return Response.json({ ok: true, data: status });
			},
			POST: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;

				let body: { action?: unknown; stagedExe?: unknown };
				try {
					body = (await request.json()) as {
						action?: unknown;
						stagedExe?: unknown;
					};
				} catch {
					return Response.json(
						{ ok: false, error: "invalid json" },
						{ status: 400 },
					);
				}

				if (!isAction(body.action)) {
					return Response.json(
						{
							ok: false,
							error: `action must be one of: ${ACTIONS.join(", ")}`,
						},
						{ status: 400 },
					);
				}

				try {
					switch (body.action) {
						case "check": {
							// Manual check: bypass the 24h cache. The user clicked,
							// they want a live answer.
							const status = await single(() => getStatus({ force: true }));
							return Response.json({ ok: true, data: status });
						}
						case "download": {
							const result = await single(() => downloadUpdate());
							return Response.json(result);
						}
						case "apply": {
							if (typeof body.stagedExe !== "string" || !body.stagedExe) {
								return Response.json(
									{ ok: false, error: "stagedExe path required" },
									{ status: 400 },
								);
							}
							const stagedExe = body.stagedExe;
							const result = await single(() => applyUpdate(stagedExe));
							return Response.json(result);
						}
					}
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					const status = message.includes("already in progress") ? 409 : 500;
					return Response.json({ ok: false, error: message }, { status });
				}
			},
		},
	},
});
