import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { applyUpdate, downloadUpdate, getStatus } from "#/lib/updates";

const ACTIONS = ["check", "download", "apply"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(v: unknown): v is Action {
	return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

type UpdateOperations = {
	forbidden: (request: Request) => Response | null;
	getStatus: typeof getStatus;
	download: typeof downloadUpdate;
	apply: typeof applyUpdate;
};

export function createUpdateRequestHandlers(operations: UpdateOperations) {
	// In-flight POST guard. Two concurrent "apply"s would race on the staged
	// exe and the spawn handoff. Keep this state scoped to one handler set so
	// tests and future server instances cannot leak action state across owners.
	let inFlight: Promise<unknown> | null = null;
	async function single<T>(fn: () => Promise<T>): Promise<T> {
		if (inFlight) throw new Error("update action already in progress");
		const pending = fn();
		inFlight = pending;
		try {
			return await pending;
		} finally {
			inFlight = null;
		}
	}

	return {
		GET: async ({ request }: { request: Request }) => {
			const forbidden = operations.forbidden(request);
			if (forbidden) return forbidden;
			const status = await operations.getStatus();
			return Response.json({ ok: true, data: status });
		},
		POST: async ({ request }: { request: Request }) => {
			const forbidden = operations.forbidden(request);
			if (forbidden) return forbidden;

			let body: { action?: unknown };
			try {
				body = (await request.json()) as { action?: unknown };
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
					case "check":
						return Response.json({
							ok: true,
							data: await single(() => operations.getStatus({ force: true })),
						});
					case "download":
						return Response.json(await single(operations.download));
					case "apply":
						return Response.json(await single(operations.apply));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const status = message.includes("already in progress") ? 409 : 500;
				return Response.json({ ok: false, error: message }, { status });
			}
		},
	};
}

const handlers = createUpdateRequestHandlers({
	forbidden: forbiddenResponse,
	getStatus,
	download: downloadUpdate,
	apply: applyUpdate,
});

export const Route = createFileRoute("/api/updates")({
	server: {
		handlers,
	},
});
