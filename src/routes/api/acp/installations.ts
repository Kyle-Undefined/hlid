import { createFileRoute } from "@tanstack/react-router";
import {
	type AcpManagedMutationRequest,
	parseAcpManagedMutationRequest,
} from "#/lib/acpManagedTypes";
import { dbFetch } from "#/lib/dbClient";
import { acpManagedInstallAccessResponse } from "#/lib/localRequest";
import { forbiddenResponse } from "#/lib/originGate";
import { isExactSameOriginMutation } from "#/lib/sameOriginRequest";

type AcpManagedInstallRouteOperations = {
	forbidden: (request: Request) => Response | null;
	access: (request: Request) => Response | null;
	mutate: (input: AcpManagedMutationRequest) => Promise<Response>;
};

function sameOriginMutationResponse(request: Request): Response | null {
	if (
		request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
	) {
		return Response.json(
			{ ok: false, error: "ACP installation actions require JSON" },
			{ status: 415 },
		);
	}
	if (!isExactSameOriginMutation(request)) {
		return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
	}
	return null;
}

export function createAcpManagedInstallRequestHandlers(
	operations: AcpManagedInstallRouteOperations,
) {
	return {
		POST: async ({ request }: { request: Request }) => {
			const sameOriginRejection = sameOriginMutationResponse(request);
			if (sameOriginRejection) return sameOriginRejection;
			const forbidden = operations.forbidden(request);
			if (forbidden) return forbidden;
			const access = operations.access(request);
			if (access) return access;

			const parsed = await parseAcpManagedMutationRequest(request);
			if (!parsed.success) {
				return Response.json(
					{ ok: false, error: "A valid ACP installation action is required" },
					{ status: 400 },
				);
			}
			return operations.mutate(parsed.data);
		},
	};
}

const handlers = createAcpManagedInstallRequestHandlers({
	forbidden: forbiddenResponse,
	access: acpManagedInstallAccessResponse,
	mutate: (input) =>
		dbFetch("/acp/managed/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		}),
});

export const Route = createFileRoute("/api/acp/installations")({
	server: { handlers },
});
