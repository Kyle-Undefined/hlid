import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import type { HlidConfig } from "../config";
import { HlidConfigSchema } from "../config";

const CONFIG_PATH = resolve(process.cwd(), "hlid.config.toml");

export function loadConfig(): HlidConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = parse(raw);
		return HlidConfigSchema.parse(parsed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return HlidConfigSchema.parse({});
		}
		throw err;
	}
}
