import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistAlwaysAllowedTool } from "./permissionStore";

describe("persistAlwaysAllowedTool", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "hlid-permission-store-"));
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("creates a local settings allow rule", () => {
		persistAlwaysAllowedTool(cwd, "Bash");
		const settings = JSON.parse(
			readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"),
		);
		expect(settings.permissions.allow).toEqual(["Bash"]);
	});

	it("preserves unrelated settings and deny rules without duplicating tools", () => {
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		const settingsPath = join(cwd, ".claude", "settings.local.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				enabledPlugins: { demo: true },
				permissions: { allow: ["Read"], deny: ["WebFetch"] },
			}),
		);

		persistAlwaysAllowedTool(cwd, "Read");
		persistAlwaysAllowedTool(cwd, "Bash");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(settings).toEqual({
			enabledPlugins: { demo: true },
			permissions: {
				allow: ["Read", "Bash"],
				deny: ["WebFetch"],
			},
		});
	});
});
