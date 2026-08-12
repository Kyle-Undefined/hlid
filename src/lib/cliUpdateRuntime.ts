import { loadConfig } from "#/server/config";
import { loadToken } from "./token";

export type CliRuntimeDrainResult = {
	sessions: number;
	appServers: number;
};

export type CliRuntimeDrainLeaseResult = CliRuntimeDrainResult & {
	leaseId: string;
};

async function ownerCliUpdateRequest(
	path: string,
	body?: Record<string, unknown>,
): Promise<Response> {
	const config = loadConfig();
	return fetch(`http://127.0.0.1:${config.server.port + 1}${path}`, {
		method: "POST",
		headers: {
			"x-hlid-internal": loadToken(),
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(10_000),
	});
}

/** Ask the owner server to release provider CLI children while leaving terminals up. */
export async function drainCliRuntime(): Promise<CliRuntimeDrainLeaseResult> {
	const response = await ownerCliUpdateRequest("/internal/cli-updates/drain");
	if (!response.ok) {
		throw new Error(`failed to stop CLI sessions (HTTP ${response.status})`);
	}
	const body = (await response.json()) as {
		ok?: unknown;
		data?: Partial<CliRuntimeDrainLeaseResult>;
	};
	if (
		body.ok !== true ||
		typeof body.data?.leaseId !== "string" ||
		body.data.leaseId.length < 1 ||
		body.data.leaseId.length > 200
	) {
		throw new Error("failed to stop CLI sessions");
	}
	return {
		sessions: Number(body.data?.sessions ?? 0),
		appServers: Number(body.data?.appServers ?? 0),
		leaseId: body.data.leaseId,
	};
}

async function requireOwnerCliUpdateAction(
	path: string,
	leaseId: string,
	failureMessage: string,
): Promise<void> {
	const response = await ownerCliUpdateRequest(path, { leaseId });
	if (!response.ok) {
		throw new Error(`${failureMessage} (HTTP ${response.status})`);
	}
	const body = (await response.json()) as { ok?: unknown };
	if (body.ok !== true) throw new Error(failureMessage);
}

/** Re-probe and replace owner-process ACP providers, then release the lease. */
export function reconcileAcpCliRuntime(leaseId: string): Promise<void> {
	return requireOwnerCliUpdateAction(
		"/internal/cli-updates/reconcile-acp",
		leaseId,
		"CLI updated, but Hlid could not refresh its runtime",
	);
}

/** Keep one exact interactive update lease alive while Forge owns its terminal. */
export function heartbeatCliRuntimeLease(leaseId: string): Promise<void> {
	return requireOwnerCliUpdateAction(
		"/internal/cli-updates/heartbeat",
		leaseId,
		"Hlid could not renew the CLI update lease",
	);
}

/** Release an update lease when no ACP runtime reconciliation is needed. */
export function releaseCliRuntimeLease(leaseId: string): Promise<void> {
	return requireOwnerCliUpdateAction(
		"/internal/cli-updates/release",
		leaseId,
		"CLI updated, but Hlid could not refresh its runtime",
	);
}
