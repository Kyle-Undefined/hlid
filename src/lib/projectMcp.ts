import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readProjectLocalSettings(projectPath: string): ProjectLocalSettings {
	return readJsonFile(
		join(projectPath, ".claude", "settings.local.json"),
	) as ProjectLocalSettings;
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

export function readProjectMcpFile(projectPath: string): {
	servers: ProjectMcpServer[];
} {
	const mcp = readJsonFile(join(projectPath, ".mcp.json"));
	const rawServers = mcp.mcpServers;
	const servers =
		rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)
			? (rawServers as Record<string, unknown>)
			: {};
	const settings = readProjectLocalSettings(projectPath);
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
