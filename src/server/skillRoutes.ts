import type { HlidConfig } from "../config";
import type { AgentProvider } from "./agentProvider";
import { loadConfig } from "./config";
import {
	discoverSkillPackages,
	importDiscoveredSkillPackages,
	readDiscoveredSkillDocument,
	removeManagedSkill,
} from "./skillImports";
import {
	discardStagedSkill,
	discoverRemoteSkills,
	installStagedSkill,
	listManagedSkills,
	readManagedSkillDocument,
	readStagedSkillFile,
	stageGitHubSkill,
} from "./skillInstalls";
import {
	getVaultSnapshot,
	invalidateVaultSnapshot,
	refreshVaultSnapshotWithStatus,
} from "./vaultSnapshot";

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

function readSkillContentRequest(
	url: URL,
	request: Request,
	invalidIdError: string,
): { ok: true; id: string } | { ok: false; response: Response } {
	if (request.method !== "GET") {
		return {
			ok: false,
			response: new Response("Method Not Allowed", { status: 405 }),
		};
	}
	const id = url.searchParams.get("id");
	if (!id || !/^[0-9a-f]{24}$/.test(id)) {
		return {
			ok: false,
			response: Response.json({ error: invalidIdError }, { status: 400 }),
		};
	}
	return { ok: true, id };
}

type SkillRouteContext = {
	url: URL;
	request: Request;
	config: HlidConfig;
	providers: ReadonlyMap<string, AgentProvider>;
};

function currentSkillConfig(fallbackConfig: HlidConfig): HlidConfig {
	try {
		return loadConfig();
	} catch {
		// Startup config is still a valid authorization boundary.
		return fallbackConfig;
	}
}

async function refreshSkillSnapshot(
	reason: "skill-import" | "skill-remove",
	config: HlidConfig,
): Promise<void> {
	invalidateVaultSnapshot(reason, config);
	await getVaultSnapshot({ refresh: true });
}

async function refreshCommittedSkillInstall(
	config: HlidConfig,
): Promise<{ code: "skill_snapshot_refresh_failed"; message: string } | null> {
	try {
		const refresh = await refreshVaultSnapshotWithStatus(
			"skill-install",
			config,
		);
		return refresh.status === "degraded"
			? {
					code: "skill_snapshot_refresh_failed",
					message: refresh.error,
				}
			: null;
	} catch (error) {
		return {
			code: "skill_snapshot_refresh_failed",
			message:
				error instanceof Error
					? error.message
					: "The shared skill snapshot could not refresh",
		};
	}
}

async function handleSkillCatalogRoute({
	request,
	config,
	providers,
}: SkillRouteContext): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	return Response.json({
		skills: await discoverSkillPackages(config, providers),
	});
}

async function handleManagedSkillListRoute({
	request,
}: SkillRouteContext): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	return Response.json({ skills: await listManagedSkills() });
}

async function handleSkillDiscoveryRoute({
	request,
}: SkillRouteContext): Promise<Response> {
	const parsed = await readPostJson<{ source?: unknown }>(request);
	if (!parsed.ok) return parsed.response;
	if (
		typeof parsed.body.source !== "string" ||
		!parsed.body.source.trim() ||
		parsed.body.source.length > 2_048
	) {
		return Response.json({ error: "invalid_skill_source" }, { status: 400 });
	}
	try {
		return Response.json({
			ok: true,
			discovery: await discoverRemoteSkills(parsed.body.source),
		});
	} catch (error) {
		return Response.json(
			{
				error: "skill_discovery_failed",
				message: error instanceof Error ? error.message : "Discovery failed",
			},
			{ status: 400 },
		);
	}
}

async function handleManagedSkillContentRoute({
	url,
	request,
}: SkillRouteContext): Promise<Response> {
	const parsed = readSkillContentRequest(url, request, "invalid_managed_skill");
	if (!parsed.ok) return parsed.response;
	const document = await readManagedSkillDocument(parsed.id);
	return document
		? Response.json(document)
		: Response.json({ error: "managed_skill_not_found" }, { status: 404 });
}

async function handleStagedSkillContentRoute({
	url,
	request,
}: SkillRouteContext): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const id = url.searchParams.get("id");
	const path = url.searchParams.get("path");
	if (!id || !/^[0-9a-f]{24}$/.test(id) || !path || path.length > 1_024) {
		return Response.json(
			{ error: "invalid_staged_skill_file" },
			{ status: 400 },
		);
	}
	try {
		const file = await readStagedSkillFile(id, path);
		return file
			? Response.json(file)
			: Response.json(
					{ error: "staged_skill_file_not_found" },
					{ status: 404 },
				);
	} catch (error) {
		return Response.json(
			{
				error: "staged_skill_read_failed",
				message: error instanceof Error ? error.message : "Read failed",
			},
			{ status: 400 },
		);
	}
}

async function handleSkillStageRoute({
	request,
}: SkillRouteContext): Promise<Response> {
	const parsed = await readPostJson<{ sourceUrl?: unknown }>(request);
	if (!parsed.ok) return parsed.response;
	if (
		typeof parsed.body.sourceUrl !== "string" ||
		!parsed.body.sourceUrl.trim() ||
		parsed.body.sourceUrl.length > 2_048
	) {
		return Response.json({ error: "invalid_skill_source" }, { status: 400 });
	}
	try {
		return Response.json({
			ok: true,
			skill: await stageGitHubSkill(parsed.body.sourceUrl),
		});
	} catch (error) {
		return Response.json(
			{
				error: "skill_stage_failed",
				message: error instanceof Error ? error.message : "Review failed",
			},
			{ status: 400 },
		);
	}
}

async function handleStagedSkillActionRoute(
	context: SkillRouteContext,
	action: "install" | "discard",
): Promise<Response> {
	const parsed = await readPostJson<{ id?: unknown }>(context.request);
	if (!parsed.ok) return parsed.response;
	const id = parsed.body.id;
	if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) {
		return Response.json({ error: "invalid_staged_skill" }, { status: 400 });
	}
	try {
		if (action === "discard") {
			const discarded = await discardStagedSkill(id);
			return discarded
				? Response.json({ ok: true })
				: Response.json({ error: "staged_skill_not_found" }, { status: 404 });
		}
		const installed = await installStagedSkill(id);
		const warning = await refreshCommittedSkillInstall(context.config);
		return Response.json({
			ok: true,
			installed,
			...(warning ? { warning } : {}),
		});
	} catch (error) {
		return Response.json(
			{
				error:
					action === "install"
						? "skill_install_failed"
						: "skill_discard_failed",
				message: error instanceof Error ? error.message : "Skill action failed",
			},
			{ status: 400 },
		);
	}
}

async function handleDiscoveredSkillContentRoute({
	url,
	request,
	config,
	providers,
}: SkillRouteContext): Promise<Response> {
	const parsed = readSkillContentRequest(url, request, "invalid_skill_id");
	if (!parsed.ok) return parsed.response;
	try {
		const document = await readDiscoveredSkillDocument({
			id: parsed.id,
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

async function handleManagedSkillRemoveRoute({
	request,
	config,
}: SkillRouteContext): Promise<Response> {
	const parsed = await readPostJson<{ id?: unknown }>(request);
	if (!parsed.ok) return parsed.response;
	const id = parsed.body.id;
	if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) {
		return Response.json({ error: "invalid_managed_skill" }, { status: 400 });
	}
	try {
		const removed = await removeManagedSkill(id);
		if (!removed) {
			return Response.json(
				{ error: "managed_skill_not_found" },
				{ status: 404 },
			);
		}
		await refreshSkillSnapshot("skill-remove", config);
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

async function handleSkillImportRoute({
	request,
	config,
	providers,
}: SkillRouteContext): Promise<Response> {
	const parsed = await readPostJson<{ ids?: unknown }>(request);
	if (!parsed.ok) return parsed.response;
	const ids = parsed.body.ids;
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > MAX_BATCH_IMPORT ||
		ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id))
	) {
		return Response.json({ error: "invalid_skill_import" }, { status: 400 });
	}
	try {
		const result = await importDiscoveredSkillPackages({
			ids: [...new Set(ids as string[])],
			config,
			providers,
		});
		if (result.imported.length > 0) {
			await refreshSkillSnapshot("skill-import", config);
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

export async function handleSkillRoute(
	url: URL,
	request: Request,
	fallbackConfig: HlidConfig,
	providers: ReadonlyMap<string, AgentProvider> = new Map(),
): Promise<Response | null> {
	const context = {
		url,
		request,
		config: currentSkillConfig(fallbackConfig),
		providers,
	};
	switch (url.pathname) {
		case "/skills/catalog":
			return handleSkillCatalogRoute(context);
		case "/skills/managed":
			return handleManagedSkillListRoute(context);
		case "/skills/discover":
			return handleSkillDiscoveryRoute(context);
		case "/skills/managed/content":
			return handleManagedSkillContentRoute(context);
		case "/skills/staged/content":
			return handleStagedSkillContentRoute(context);
		case "/skills/stage":
			return handleSkillStageRoute(context);
		case "/skills/install":
			return handleStagedSkillActionRoute(context, "install");
		case "/skills/discard":
			return handleStagedSkillActionRoute(context, "discard");
		case "/skills/content":
			return handleDiscoveredSkillContentRoute(context);
		case "/skills/remove":
			return handleManagedSkillRemoveRoute(context);
		case "/skills/import":
			return handleSkillImportRoute(context);
		default:
			return null;
	}
}
