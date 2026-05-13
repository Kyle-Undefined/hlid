import { readFileSync, statSync } from "node:fs";
import { parse } from "smol-toml";
import type { HlidConfig } from "../config";
import { HlidConfigSchema } from "../config";
import { CONFIG_PATH } from "../lib/paths";

let _cache: { config: HlidConfig; mtimeMs: number } | null = null;

/** Update the in-memory cache after a write so the next loadConfig() is free. */
export function setConfigCache(config: HlidConfig): void {
	try {
		const { mtimeMs } = statSync(CONFIG_PATH);
		_cache = { config, mtimeMs };
	} catch {
		_cache = null;
	}
}

export function loadConfig(): HlidConfig {
	try {
		const { mtimeMs } = statSync(CONFIG_PATH);
		if (_cache && _cache.mtimeMs === mtimeMs) return _cache.config;
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const config = HlidConfigSchema.parse(parse(raw));
		_cache = { config, mtimeMs };
		return config;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			_cache = null;
			return HlidConfigSchema.parse({});
		}
		throw err;
	}
}
