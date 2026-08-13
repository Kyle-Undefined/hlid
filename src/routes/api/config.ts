import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { HlidConfigSchema } from "#/config";
import { acpRuntimeIdentity } from "#/lib/acpRuntimeIdentity";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { publicConfig, restoreConfigSecrets } from "#/lib/publicConfig";
import {
	acpDiscoveryCwd,
	OpenCodeConfigOverlayError,
	preflightOpenCodeModelFilter,
} from "#/server/acpRuntime";
import { loadConfig } from "#/server/config";

let pendingAcpRuntimeTarget: string | null = null;

function acpRuntimeTarget(
	config: ReturnType<typeof HlidConfigSchema.parse>,
): string {
	const discoveryCwds = (config.acp_agents ?? [])
		.map((agent) => [agent.id, acpDiscoveryCwd(config, agent)] as const)
		.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256")
		.update(config.vault.path)
		.update("\0")
		.update(acpRuntimeIdentity(config.acp_agents ?? []))
		.update("\0")
		.update(JSON.stringify(discoveryCwds))
		.digest("base64url");
}

export async function handleGetConfig(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	return Response.json(publicConfig(loadConfig()));
}

export async function handlePostConfig(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	let current: ReturnType<typeof HlidConfigSchema.parse>;
	let config: ReturnType<typeof HlidConfigSchema.parse>;
	try {
		current = loadConfig();
		config = HlidConfigSchema.parse(
			restoreConfigSecrets(await request.json(), current),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid config";
		return Response.json({ error: message }, { status: 400 });
	}
	const currentAcpRuntimeTarget = acpRuntimeTarget(current);
	if (
		pendingAcpRuntimeTarget &&
		pendingAcpRuntimeTarget !== currentAcpRuntimeTarget
	) {
		pendingAcpRuntimeTarget = null;
	}
	if (config.vault.path) {
		try {
			const vaultStat = await stat(expandTilde(config.vault.path));
			if (!vaultStat.isDirectory()) {
				return Response.json(
					{ error: "vault.path is not a directory" },
					{ status: 400 },
				);
			}
		} catch {
			return Response.json(
				{ error: "vault.path does not exist" },
				{ status: 400 },
			);
		}
	}
	if (config.umbod.enabled) {
		try {
			const { ensureUmbodManifest } = await import("#/server/umbod");
			await ensureUmbodManifest(config.umbod.manifest_path);
		} catch (error) {
			return Response.json(
				{
					error: `Invalid Umbod manifest: ${error instanceof Error ? error.message : String(error)}`,
				},
				{ status: 400 },
			);
		}
	}
	try {
		preflightOpenCodeModelFilter(config);
	} catch (error) {
		if (error instanceof OpenCodeConfigOverlayError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
	if (config.acp_agents?.some((agent) => agent.model_filter)) {
		let response: Response;
		try {
			response = await dbFetch("/acp/preflight", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(config),
			});
		} catch {
			return Response.json(
				{ error: "Unable to validate the OpenCode runtime configuration" },
				{ status: 503 },
			);
		}
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: unknown;
			} | null;
			return Response.json(
				{
					error:
						typeof body?.error === "string"
							? body.error
							: "The OpenCode runtime configuration is invalid",
				},
				{ status: 400 },
			);
		}
	}
	try {
		writeConfig(config);
	} catch {
		return Response.json({ error: "Failed to write config" }, { status: 500 });
	}
	let eventLogPolicyWarning: string | undefined;
	try {
		const response = await dbFetch("/db/logs/policy", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: config.diagnostics.event_log }),
		});
		if (!response.ok) {
			eventLogPolicyWarning =
				"Event Log persistence will use its previous setting until Hlid restarts.";
		}
	} catch {
		eventLogPolicyWarning =
			"Event Log persistence will use its previous setting until Hlid restarts.";
	}
	void dbFetch("/voice/sync", { method: "POST" }).catch(() => {});
	const codexRuntimeIdentityChanged =
		current.voice.codex_live_mode !== config.voice.codex_live_mode ||
		current.codex.executable !== config.codex.executable;
	const currentAcpAgents = current.acp_agents ?? [];
	const nextAcpAgents = config.acp_agents ?? [];
	const nextAcpRuntimeTarget = acpRuntimeTarget(config);
	const acpRuntimeIdentityChanged =
		(currentAcpAgents.length > 0 || nextAcpAgents.length > 0) &&
		currentAcpRuntimeTarget !== nextAcpRuntimeTarget;
	const acpRuntimeSyncRequired =
		acpRuntimeIdentityChanged ||
		pendingAcpRuntimeTarget === nextAcpRuntimeTarget;
	const codexRuntimeSync = dbFetch("/cliproxy/sync", { method: "POST" });
	const acpRuntimeSync = acpRuntimeSyncRequired
		? dbFetch("/acp/sync", { method: "POST" })
		: null;
	if (acpRuntimeIdentityChanged) {
		void import("#/server/cliUpdates")
			.then(({ invalidateAcpCliUpdateStatuses }) =>
				invalidateAcpCliUpdateStatuses(),
			)
			.catch(() => {});
	}
	if (!codexRuntimeIdentityChanged && !acpRuntimeSyncRequired) {
		void codexRuntimeSync.catch(() => {});
		return Response.json({
			ok: true,
			runtime_synced: true,
			acp_runtime_synced: true,
			...(eventLogPolicyWarning ? { warning: eventLogPolicyWarning } : {}),
		});
	}
	// Realtime launch flags and the executable are process identity. Wait for the
	// runtime transition, while keeping the already-persisted config save truthful
	// if the follow-up synchronization itself fails.
	const runtimeWarnings: string[] = [];
	const waitForRuntime = async (
		label: string,
		request: Promise<Response>,
	): Promise<boolean> => {
		try {
			const response = await request;
			if (!response.ok) {
				const body = (await response
					.clone()
					.json()
					.catch(() => null)) as { error?: unknown } | null;
				const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
				const suffix = detail.endsWith(".") ? "" : ".";
				runtimeWarnings.push(
					`${label} runtime synchronization returned ${response.status}${detail}${suffix}`,
				);
				return false;
			}
			return true;
		} catch (error) {
			runtimeWarnings.push(
				`${label} runtime synchronization failed: ${
					error instanceof Error ? error.message : String(error)
				}.`,
			);
			return false;
		}
	};
	if (codexRuntimeIdentityChanged) {
		await waitForRuntime("Codex", codexRuntimeSync);
	} else {
		void codexRuntimeSync.catch(() => {});
	}
	let acpRuntimeSynced = true;
	if (acpRuntimeSyncRequired) {
		acpRuntimeSynced = await waitForRuntime(
			"ACP",
			acpRuntimeSync as Promise<Response>,
		);
		pendingAcpRuntimeTarget = acpRuntimeSynced ? null : nextAcpRuntimeTarget;
	}
	const runtimeWarning =
		[runtimeWarnings.join(" "), eventLogPolicyWarning]
			.filter((warning): warning is string => Boolean(warning))
			.join(" ") || undefined;
	if (runtimeWarning) {
		console.warn(`[config] ${runtimeWarning}`);
		return Response.json({
			ok: true,
			runtime_synced: runtimeWarnings.length === 0,
			acp_runtime_synced: acpRuntimeSynced,
			warning: runtimeWarning,
		});
	}
	return Response.json({
		ok: true,
		runtime_synced: true,
		acp_runtime_synced: true,
	});
}

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetConfig(request),
			POST: ({ request }) => handlePostConfig(request),
		},
	},
});
