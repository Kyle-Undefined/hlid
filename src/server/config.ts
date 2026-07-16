import { readFileSync, statSync } from "node:fs";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { type HlidConfig, HlidConfigSchema } from "../config";
import { CONFIG_PATH } from "../lib/paths";

let configCache: { config: HlidConfig; mtimeMs: number } | null = null;

function parseConfig(raw: string): HlidConfig {
	try {
		return HlidConfigSchema.parse(parse(raw));
	} catch (err) {
		if (err instanceof z.ZodError) {
			throw new Error(
				`Invalid config at ${CONFIG_PATH}:\n${z.prettifyError(err)}`,
			);
		}
		if (err instanceof TomlError) {
			throw new Error(`Invalid TOML in ${CONFIG_PATH}:\n${err.message}`);
		}
		throw err;
	}
}

/** Update the shared cache after an atomic config write. */
export function setConfigCache(config: HlidConfig): void {
	try {
		configCache = { config, mtimeMs: statSync(CONFIG_PATH).mtimeMs };
	} catch {
		configCache = null;
	}
}

/** Load the latest config, parsing only when its on-disk mtime changes. */
export function loadConfig(): HlidConfig {
	try {
		const { mtimeMs } = statSync(CONFIG_PATH);
		if (configCache?.mtimeMs === mtimeMs) return configCache.config;
		const config = parseConfig(readFileSync(CONFIG_PATH, "utf-8"));
		configCache = { config, mtimeMs };
		return config;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			configCache = null;
			return HlidConfigSchema.parse({});
		}
		throw err;
	}
}
