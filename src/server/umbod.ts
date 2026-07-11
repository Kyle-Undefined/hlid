import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApprovalDecision, ToolCall, Umbod } from "@umbod/core";
import { APP_DIR } from "#/lib/paths";
import { loadConfig } from "#/server/config";
import {
	defaultUmbodManifest,
	resolveUmbodManifestPath,
} from "#/server/umbodManifest";

export { ensureUmbodManifest } from "#/server/umbodManifest";

let instance: Umbod | null = null;
let instancePath: string | null = null;
let hookServer: ReturnType<typeof Bun.serve> | null = null;

async function getUmbod(): Promise<Umbod | null> {
	const config = loadConfig()?.umbod ?? {
		enabled: false,
		manifest_path: "umbod.toml",
	};
	if (!config.enabled) return null;
	const path = resolveUmbodManifestPath(config.manifest_path);
	if (instance && instancePath === path) return instance;
	instance?.close();
	const { createUmbod, loadManifest } = await import("@umbod/core");
	const manifest = await loadManifest(path);
	instance = createUmbod({
		manifest,
		dbPath: resolve(APP_DIR, "umbod.hlid.db"),
		sessionLogSources: [{ agent: "claude" }, { agent: "codex" }],
	});
	instancePath = path;
	return instance;
}

export async function bootstrapUmbod(): Promise<void> {
	const umbod = await getUmbod();
	if (!umbod || hookServer) return;
	hookServer = Bun.serve({
		hostname: umbod.manifest.server.host,
		port: umbod.manifest.server.port,
		fetch(request) {
			return (
				umbod.fetch(request) ??
				Response.json({ ok: false, error: "Not found" }, { status: 404 })
			);
		},
	});
	console.info(
		`[umbod] hook server listening on http://${umbod.manifest.server.host}:${hookServer.port}`,
	);
}

export async function authorizeHlidTool(options: {
	agent: string;
	tool: string;
	input: unknown;
	cwd: string;
	sessionId?: string;
	toolUseId: string;
	bypassApproval: boolean;
	prompt: (reason: string) => Promise<Exclude<ApprovalDecision, "approve">>;
}): Promise<{
	decision: "allow" | "block";
	policyDecision: ApprovalDecision;
	reason?: string;
} | null> {
	const umbod = await getUmbod();
	if (!umbod) return null;
	const inputs =
		options.input && typeof options.input === "object"
			? (options.input as Record<string, unknown>)
			: { value: options.input };
	const command =
		typeof inputs.command === "string"
			? inputs.command
			: typeof inputs.file_path === "string"
				? `${options.tool} ${inputs.file_path}`
				: `${options.tool} ${JSON.stringify(inputs)}`;
	const call: ToolCall = {
		agent: options.agent,
		tool: options.tool,
		command,
		inputs,
		workingDirectory: options.cwd,
		timestamp: new Date().toISOString(),
		sessionId: options.sessionId,
		toolUseId: options.toolUseId,
	};
	const result = await umbod.authorize(call, {
		bypassApproval: options.bypassApproval,
		approvalPrompt: async (_call, reason) => options.prompt(reason),
	});
	return {
		decision: result.decision,
		policyDecision: result.policyDecision,
		reason: result.entry.reason,
	};
}

export async function umbodSnapshot(): Promise<Record<string, unknown>> {
	const config = loadConfig()?.umbod ?? {
		enabled: false,
		manifest_path: "umbod.toml",
	};
	const source = await readFile(
		resolveUmbodManifestPath(config.manifest_path),
		"utf8",
	).catch(() => defaultUmbodManifest());
	const umbod = await getUmbod();
	if (!umbod) return { enabled: false, source };
	return {
		enabled: true,
		source,
		manifest: umbod.manifest,
		tools: await Promise.resolve(
			umbod.fetch(new Request("http://hlid/api/analytics/tools?recentDays=14")),
		).then((r) => r?.json()),
		rules: await Promise.resolve(
			umbod.fetch(new Request("http://hlid/api/analytics/rules")),
		).then((r) => r?.json()),
	};
}

export async function umbodCalls(
	searchParams: URLSearchParams,
): Promise<unknown> {
	const umbod = await getUmbod();
	if (!umbod)
		return { entries: [], page: 1, pageSize: 50, total: 0, totalPages: 1 };
	const url = new URL("http://hlid/api/analytics/calls");
	for (const [key, value] of searchParams) {
		if (key !== "view") url.searchParams.set(key, value);
	}
	const response = await Promise.resolve(umbod.fetch(new Request(url)));
	if (!response) throw new Error("Umbod call explorer is unavailable");
	return response.json();
}

export async function umbodHookArtifacts(
	agents: string[],
	target: "wsl" | "windows",
): Promise<unknown[]> {
	const { findAdapterById } = await import("@umbod/core");
	const umbod = await getUmbod();
	const timeoutSeconds = umbod?.manifest.env.timeout ?? 300;
	const isWsl = target === "wsl";
	const outputDir = isWsl ? "~/.umbod" : resolve(APP_DIR, "umbod-hooks");
	return agents.map((agent) => {
		const adapter = findAdapterById(agent);
		if (!adapter) throw new Error(`Unknown Umbod agent: ${agent}`);
		const result = adapter.install({
			url: "http://127.0.0.1:9090",
			outputDir,
			timeoutSeconds,
			platform: isWsl ? "posix" : "windows",
			homeDir: isWsl ? "~" : undefined,
		});
		return {
			agent,
			displayName: adapter.displayName,
			assets: result.assets,
			config: {
				...result.config,
				contents:
					typeof result.config.contents === "string"
						? result.config.contents
						: `${JSON.stringify(result.config.contents, null, 2)}\n`,
			},
		};
	});
}

export async function saveUmbodManifest(source: string): Promise<void> {
	const { loadManifest } = await import("@umbod/core");
	const path = resolveUmbodManifestPath(
		loadConfig()?.umbod?.manifest_path ?? "umbod.toml",
	);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, source, { encoding: "utf8", mode: 0o600 });
	try {
		await loadManifest(temporary);
		await rename(temporary, path);
		closeUmbod();
	} catch (error) {
		await Bun.file(temporary)
			.delete()
			.catch(() => {});
		throw error;
	}
}

export function closeUmbod(): void {
	hookServer?.stop(true);
	hookServer = null;
	instance?.close();
	instance = null;
	instancePath = null;
}
