import { createFileRoute } from "@tanstack/react-router";
import { parseJsonAction } from "#/lib/actionRequest";
import { isLocalUiRequest, localOnlyResponse } from "#/lib/localRequest";
import { forbiddenResponse } from "#/lib/originGate";
import { applyUpdate, downloadUpdate, getStatus } from "#/lib/updates";
import { applyCliUpdate, prepareCliUpdate } from "#/server/cliUpdateActions";

const ACTIONS = [
	"check",
	"download",
	"apply",
	"prepare_cli",
	"apply_cli",
] as const;
type UpdateOperations = {
	forbidden: (request: Request) => Response | null;
	localOnly: (request: Request) => Response | null;
	isLocal: (request: Request) => boolean;
	getStatus: typeof getStatus;
	download: typeof downloadUpdate;
	apply: typeof applyUpdate;
	prepareCli: typeof prepareCliUpdate;
	applyCli: typeof applyCliUpdate;
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
			return Response.json({
				ok: true,
				data: {
					...status,
					cliUpdateActionsAllowed: operations.isLocal(request),
				},
			});
		},
		POST: async ({ request }: { request: Request }) => {
			const forbidden = operations.forbidden(request);
			if (forbidden) return forbidden;

			const parsed = await parseJsonAction(request, ACTIONS, "invalid json");
			if (parsed instanceof Response) return parsed;
			const cliAction =
				parsed.action === "prepare_cli" || parsed.action === "apply_cli";
			let cliId: string | null = null;
			if (cliAction) {
				const localOnly = operations.localOnly(request);
				if (localOnly) return localOnly;
				if (typeof parsed.body.id !== "string" || parsed.body.id.length > 200) {
					return Response.json(
						{ ok: false, error: "id is required" },
						{ status: 400 },
					);
				}
				cliId = parsed.body.id;
			}

			try {
				switch (parsed.action) {
					case "check":
						return Response.json({
							ok: true,
							data: await single(() => operations.getStatus({ force: true })),
						});
					case "download":
						return Response.json(await single(operations.download));
					case "apply":
						return Response.json(await single(operations.apply));
					case "prepare_cli":
						return Response.json({
							ok: true,
							data: await single(() => operations.prepareCli(cliId as string)),
						});
					case "apply_cli":
						return Response.json({
							ok: true,
							data: await single(() => operations.applyCli(cliId as string)),
						});
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
	localOnly: localOnlyResponse,
	isLocal: isLocalUiRequest,
	getStatus,
	download: downloadUpdate,
	apply: applyUpdate,
	prepareCli: prepareCliUpdate,
	applyCli: applyCliUpdate,
});

export const Route = createFileRoute("/api/updates")({
	server: {
		handlers,
	},
});
