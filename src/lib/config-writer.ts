import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HlidConfig } from "../config";

const CONFIG_PATH = resolve(process.cwd(), "hlid.config.toml");

function tomlVal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value))
		return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
	return JSON.stringify(value);
}

export function writeConfig(config: HlidConfig): void {
	const lines: string[] = [];

	lines.push("[vault]");
	lines.push(`name = ${tomlVal(config.vault.name)}`);
	lines.push(`path = ${tomlVal(config.vault.path)}`);
	if (config.vault.inbox) lines.push(`inbox = ${tomlVal(config.vault.inbox)}`);
	if (config.vault.projects)
		lines.push(`projects = ${tomlVal(config.vault.projects)}`);
	if (config.vault.areas) lines.push(`areas = ${tomlVal(config.vault.areas)}`);
	if (config.vault.skills)
		lines.push(`skills = ${tomlVal(config.vault.skills)}`);
	if (config.vault.memory)
		lines.push(`memory = ${tomlVal(config.vault.memory)}`);

	lines.push("");
	lines.push("[server]");
	lines.push(`port = ${tomlVal(config.server.port)}`);
	lines.push(`host = ${tomlVal(config.server.host)}`);

	lines.push("");
	lines.push("[claude]");
	lines.push(`model = ${tomlVal(config.claude.model)}`);
	lines.push(`permission_mode = ${tomlVal(config.claude.permission_mode)}`);

	lines.push("");
	lines.push("[status_vocabulary]");
	lines.push(`active = ${tomlVal(config.status_vocabulary.active)}`);
	lines.push(`planning = ${tomlVal(config.status_vocabulary.planning)}`);
	lines.push(`done = ${tomlVal(config.status_vocabulary.done)}`);

	writeFileSync(CONFIG_PATH, `${lines.join("\n")}\n`, "utf-8");
}
