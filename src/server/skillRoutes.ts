import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";
import { loadConfig } from "./config";
import {
	discoverSkillPackages,
	importDiscoveredSkillPackages,
	readDiscoveredSkillDocument,
	removeManagedSkill,
} from "./skillImports";
import { getVaultSnapshot, invalidateVaultSnapshot } from "./vaultSnapshot";

const MAX_BATCH_IMPORT = 100;

async function readPostJson<T>(
	request: Request,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
	if (request.method !== "POST") {
		return {
			ok: false,
			response: new Response("Method Not Allowed", { status: 405 }),
		};
	}
	try {
		return { ok: true, body: (await request.json()) as T };
	} catch {
		return {
			ok: false,
			response: Response.json({ error: "invalid_json" }, { status: 400 }),
		};
	}
}

export async function handleSkillRoute(
	url: URL,
	request: Request,
	fallbackConfig: HlidConfig,
	providers: ReadonlyMap<string, AgentProvider> = new Map(),
): Promise<Response | null> {
	let config = fallbackConfig;
	try {
		config = loadConfig();
	} catch {
		// Startup config is still a valid authorization boundary.
	}
	if (url.pathname === "/skills/catalog") {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return Response.json({
			skills: await discoverSkillPackages(config, providers),
		});
	}
	if (url.pathname === "/skills/content") {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		const id = url.searchParams.get("id");
		if (!id || !/^[0-9a-f]{24}$/.test(id)) {
			return Response.json({ error: "invalid_skill_id" }, { status: 400 });
		}
		try {
			const document = await readDiscoveredSkillDocument({
				id,
				config,
				providers,
			});
			return document
				? Response.json(document)
				: Response.json({ error: "skill_not_found" }, { status: 404 });
		} catch (error) {
			return Response.json(
				{
					error: "skill_preview_failed",
					message: error instanceof Error ? error.message : "Preview failed",
				},
				{ status: 400 },
			);
		}
	}
	if (url.pathname === "/skills/remove") {
		const parsed = await readPostJson<{ id?: unknown }>(request);
		if (!parsed.ok) return parsed.response;
		const { body } = parsed;
		if (typeof body.id !== "string" || !/^[0-9a-f]{24}$/.test(body.id)) {
			return Response.json({ error: "invalid_managed_skill" }, { status: 400 });
		}
		try {
			const removed = await removeManagedSkill(body.id);
			if (!removed) {
				return Response.json(
					{ error: "managed_skill_not_found" },
					{ status: 404 },
				);
			}
			invalidateVaultSnapshot("skill-remove", config);
			await getVaultSnapshot({ refresh: true });
			return Response.json({ ok: true, removed });
		} catch (error) {
			return Response.json(
				{
					error: "skill_remove_failed",
					message: error instanceof Error ? error.message : "Remove failed",
				},
				{ status: 400 },
			);
		}
	}
	if (url.pathname !== "/skills/import") return null;
	const parsed = await readPostJson<{ ids?: unknown }>(request);
	if (!parsed.ok) return parsed.response;
	const { body } = parsed;
	if (
		!Array.isArray(body.ids) ||
		body.ids.length === 0 ||
		body.ids.length > MAX_BATCH_IMPORT ||
		body.ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id))
	) {
		return Response.json({ error: "invalid_skill_import" }, { status: 400 });
	}
	try {
		const result = await importDiscoveredSkillPackages({
			ids: [...new Set(body.ids as string[])],
			config,
			providers,
		});
		if (result.imported.length > 0) {
			invalidateVaultSnapshot("skill-import", config);
			await getVaultSnapshot({ refresh: true });
		}
		return Response.json({ ok: result.failed.length === 0, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Import failed";
		return Response.json(
			{ error: "skill_import_failed", message },
			{ status: 400 },
		);
	}
}
