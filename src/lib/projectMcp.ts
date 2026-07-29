import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomicFile";

export type ProjectMcpServer = {
	name: string;
	config: unknown;
	disabled: boolean;
};

export type ProjectLocalSettings = Record<string, unknown> & {
	disabledMcpjsonServers?: string[];
	permissions?: { allow?: string[]; deny?: string[] };
};

function readJsonFile(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function readJsonFileAsync(
	path: string,
): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		createParent: true,
	});
}

function readProjectLocalSettings(projectPath: string): ProjectLocalSettings {
	return readJsonFile(
		join(projectPath, ".claude", "settings.local.json"),
	) as ProjectLocalSettings;
}

async function readProjectLocalSettingsAsync(
	projectPath: string,
): Promise<ProjectLocalSettings> {
	return readJsonFileAsync(
		join(projectPath, ".claude", "settings.local.json"),
	) as Promise<ProjectLocalSettings>;
}

export function updateProjectLocalSettings(
	projectPath: string,
	update: (settings: ProjectLocalSettings) => void,
): void {
	const settings = readProjectLocalSettings(projectPath);
	update(settings);
	writeJsonAtomic(
		join(projectPath, ".claude", "settings.local.json"),
		settings,
	);
}

function mergeProjectMcpFiles(
	mcp: Record<string, unknown>,
	settings: ProjectLocalSettings,
): { servers: ProjectMcpServer[] } {
	const rawServers = mcp.mcpServers;
	const servers =
		rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)
			? (rawServers as Record<string, unknown>)
			: {};
	const disabled = Array.isArray(settings.disabledMcpjsonServers)
		? settings.disabledMcpjsonServers.filter(
				(name): name is string => typeof name === "string",
			)
		: [];
	return {
		servers: Object.entries(servers).map(([name, config]) => ({
			name,
			config,
			disabled: disabled.includes(name),
		})),
	};
}

export function readProjectMcpFile(projectPath: string): {
	servers: ProjectMcpServer[];
} {
	return mergeProjectMcpFiles(
		readJsonFile(join(projectPath, ".mcp.json")),
		readProjectLocalSettings(projectPath),
	);
}

export async function readProjectMcpFileAsync(projectPath: string): Promise<{
	servers: ProjectMcpServer[];
}> {
	const [mcp, settings] = await Promise.all([
		readJsonFileAsync(join(projectPath, ".mcp.json")),
		readProjectLocalSettingsAsync(projectPath),
	]);
	return mergeProjectMcpFiles(mcp, settings);
}

export function writeProjectMcpFile(
	projectPath: string,
	servers: Record<string, unknown>,
): void {
	writeJsonAtomic(join(projectPath, ".mcp.json"), { mcpServers: servers });
}

export function toggleProjectMcpFile(
	projectPath: string,
	name: string,
	disabled: boolean,
): void {
	updateProjectLocalSettings(projectPath, (settings) => {
		const disabledSet = new Set(
			Array.isArray(settings.disabledMcpjsonServers)
				? settings.disabledMcpjsonServers.filter(
						(value): value is string => typeof value === "string",
					)
				: [],
		);
		if (disabled) disabledSet.add(name);
		else disabledSet.delete(name);
		settings.disabledMcpjsonServers = [...disabledSet];
	});
}
