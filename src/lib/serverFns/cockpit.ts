/** Cockpit dashboard data (vault inbox/projects/skills scan) server fn. */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { getConfig } from "#/config";
import { collectCockpitData } from "#/lib/cockpitData";

export const getCockpitData = createServerFn({ method: "GET" }).handler(
	async () => {
		const { scanProjects, scanSkills } = await import("#/lib/vault");
		const config = await getConfig();
		return collectCockpitData(config, {
			readDirectory: readdirSync,
			scanProjects,
			scanSkills,
			joinPath: join,
			claudeSkillsDir: resolve(homedir(), ".claude", "skills"),
		});
	},
);
