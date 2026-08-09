import { stat } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { HlidConfigSchema } from "#/config";
import { acpRuntimeIdentity } from "#/lib/acpRuntimeIdentity";
import { writeConfig } from "#/lib/config-writer";
import { dbFetch } from "#/lib/dbClient";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde } from "#/lib/paths";
import { publicConfig, restoreConfigSecrets } from "#/lib/publicConfig";
import { loadConfig } from "#/server/config";

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
		writeConfig(config);
	} catch {
		return Response.json({ error: "Failed to write config" }, { status: 500 });
	}
	void dbFetch("/voice/sync", { method: "POST" }).catch(() => {});
	const codexRuntimeIdentityChanged =
		current.voice.codex_live_mode !== config.voice.codex_live_mode ||
		current.codex.executable !== config.codex.executable;
	const currentAcpAgents = current.acp_agents ?? [];
	const nextAcpAgents = config.acp_agents ?? [];
	const acpRuntimeIdentityChanged =
		acpRuntimeIdentity(currentAcpAgents) !==
			acpRuntimeIdentity(nextAcpAgents) ||
		(current.vault.path !== config.vault.path &&
			(currentAcpAgents.length > 0 || nextAcpAgents.length > 0));
	const codexRuntimeSync = dbFetch("/cliproxy/sync", { method: "POST" });
	const acpRuntimeSync = acpRuntimeIdentityChanged
		? dbFetch("/acp/sync", { method: "POST" })
		: null;
	if (!codexRuntimeIdentityChanged && !acpRuntimeIdentityChanged) {
		void codexRuntimeSync.catch(() => {});
		return Response.json({ ok: true });
	}
	// Realtime launch flags and the executable are process identity. Wait for the
	// runtime transition, while keeping the already-persisted config save truthful
	// if the follow-up synchronization itself fails.
	const runtimeWarnings: string[] = [];
	const waitForRuntime = async (
		label: string,
		request: Promise<Response>,
	): Promise<void> => {
		try {
			const response = await request;
			if (!response.ok) {
				runtimeWarnings.push(
					`${label} runtime synchronization returned ${response.status}.`,
				);
			}
		} catch (error) {
			runtimeWarnings.push(
				`${label} runtime synchronization failed: ${
					error instanceof Error ? error.message : String(error)
				}.`,
			);
		}
	};
	if (codexRuntimeIdentityChanged) {
		await waitForRuntime("Codex", codexRuntimeSync);
	} else {
		void codexRuntimeSync.catch(() => {});
	}
	if (acpRuntimeIdentityChanged) {
		await waitForRuntime("ACP", acpRuntimeSync as Promise<Response>);
	}
	const runtimeWarning = runtimeWarnings.join(" ") || undefined;
	if (runtimeWarning) {
		console.warn(`[config] ${runtimeWarning}`);
		return Response.json({
			ok: true,
			runtime_synced: false,
			warning: runtimeWarning,
		});
	}
	return Response.json({ ok: true, runtime_synced: true });
}

export const Route = createFileRoute("/api/config")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetConfig(request),
			POST: ({ request }) => handlePostConfig(request),
		},
	},
});
