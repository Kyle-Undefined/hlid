import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HlidConfig, HlidConfigSchema } from "../config";
import {
	discoverInstructionFileTargets,
	readInstructionFile,
	writeInstructionFile,
} from "./instructionFiles";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `hlid-${name}-`));
	roots.push(root);
	return root;
}

function config(
	vaultPath: string,
	agents: HlidConfig["agents"] = [],
	vaultProvider = "claude",
): HlidConfig {
	return HlidConfigSchema.parse({
		vault: { name: "Fornbok", path: vaultPath },
		agents,
		vault_provider: vaultProvider,
	});
}

describe("instruction file discovery", () => {
	it("lists configured targets without eagerly inspecting their files", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		writeFileSync(join(vault, "CLAUDE.md"), "# Claude\n");

		const target = (
			await discoverInstructionFileTargets(config(vault), {
				home,
				platform: "linux",
				wslDistro: "",
			})
		).find((candidate) => candidate.owner === "vault");

		expect(target).toMatchObject({
			filename: "CLAUDE.md",
			exists: null,
			size: null,
			revision: null,
			writable: true,
		});
		if (!target) return;

		const opened = await readInstructionFile(config(vault), target.id, {
			home,
			platform: "linux",
			wslDistro: "",
		});
		expect(opened).toMatchObject({
			exists: true,
			size: 9,
			content: "# Claude\n",
		});
		expect(opened.revision).toHaveLength(64);
	});

	it("scopes Codex-only targets to AGENTS.md", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const agent = scratch("instructions-agent");

		const targets = await discoverInstructionFileTargets(
			config(
				vault,
				[
					{
						path: agent,
						name: "Reviewer",
						mode: "cwd",
						provider: "codex",
					},
				],
				"codex",
			),
			{ home, platform: "linux", wslDistro: "" },
		);

		expect(targets).toHaveLength(3);
		expect(targets.map((target) => target.filename)).toEqual([
			"AGENTS.md",
			"AGENTS.md",
			"AGENTS.md",
		]);
	});

	it("scopes Claude-only targets to CLAUDE.md", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const agent = scratch("instructions-agent");
		const targets = await discoverInstructionFileTargets(
			config(vault, [
				{ path: agent, name: "Reviewer", mode: "cwd", provider: "claude" },
			]),
			{ home, platform: "linux", wslDistro: "" },
		);
		expect(targets).toHaveLength(3);
		expect(targets.map((target) => target.filename)).toEqual([
			"CLAUDE.md",
			"CLAUDE.md",
			"CLAUDE.md",
		]);
	});

	it("uses the union of configured provider families for globals and each agent's own provider", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const codex = scratch("instructions-codex");
		const claude = scratch("instructions-claude");
		const targets = await discoverInstructionFileTargets(
			config(
				vault,
				[
					{ path: codex, name: "Codex", mode: "cwd", provider: "codex" },
					{ path: claude, name: "Claude", mode: "cwd", provider: "claude" },
				],
				"codex",
			),
			{ home, platform: "linux", wslDistro: "" },
		);
		expect(
			targets
				.filter((target) => target.owner === "global")
				.map((target) => target.filename),
		).toEqual(["AGENTS.md", "CLAUDE.md"]);
		expect(
			targets
				.filter((target) => target.owner === "vault")
				.map((target) => target.filename),
		).toEqual(["AGENTS.md"]);
		expect(
			targets
				.filter((target) => target.agentPath === codex)
				.map((target) => target.filename),
		).toEqual(["AGENTS.md"]);
		expect(
			targets
				.filter((target) => target.agentPath === claude)
				.map((target) => target.filename),
		).toEqual(["CLAUDE.md"]);
	});

	it("derives one WSL user home from configured UNC workspaces", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const wslAgent =
			"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid";

		const targets = await discoverInstructionFileTargets(
			config(vault, [
				{ path: wslAgent, name: "Hlid", mode: "cwd", provider: "codex" },
				{
					path: wslAgent.replace("hlid", "other"),
					name: "Other",
					mode: "cwd",
					provider: "claude",
				},
			]),
			{ home, platform: "win32", wslDistro: "" },
		);

		const globals = targets.filter(
			(target) => target.owner === "global" && target.environment === "wsl",
		);
		expect(globals).toHaveLength(2);
		expect(globals.map((target) => target.path)).toContain(
			win32.join(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle",
				".codex",
				"AGENTS.md",
			),
		);
	});
});

describe("instruction file editing", () => {
	it("creates files, returns revisions, and rejects stale saves", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const currentConfig = config(vault);
		const target = (
			await discoverInstructionFileTargets(currentConfig, {
				home,
				platform: "linux",
				wslDistro: "",
			})
		).find(
			(candidate) =>
				candidate.owner === "vault" && candidate.filename === "CLAUDE.md",
		);
		expect(target).toBeDefined();
		if (!target) return;

		const created = await writeInstructionFile(
			currentConfig,
			{ id: target.id, content: "# Claude\n", expectedRevision: null },
			{ home, platform: "linux", wslDistro: "" },
		);
		expect(created.content).toBe("# Claude\n");
		expect(created.revision).toHaveLength(64);
		expect(readFileSync(join(vault, "CLAUDE.md"), "utf8")).toBe("# Claude\n");

		await expect(
			writeInstructionFile(
				currentConfig,
				{ id: target.id, content: "stale", expectedRevision: null },
				{ home, platform: "linux", wslDistro: "" },
			),
		).rejects.toThrow("changed since it was opened");
	});

	it("preserves an in-root instruction symlink", async () => {
		if (process.platform === "win32") return;
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		writeFileSync(join(vault, "AGENTS.md"), "old");
		symlinkSync("AGENTS.md", join(vault, "CLAUDE.md"));
		const currentConfig = config(vault);
		const targets = await discoverInstructionFileTargets(currentConfig, {
			home,
			platform: "linux",
			wslDistro: "",
		});
		const target = targets.find(
			(candidate) =>
				candidate.owner === "vault" && candidate.filename === "CLAUDE.md",
		);
		expect(target).toBeDefined();
		if (!target) return;
		const document = await readInstructionFile(currentConfig, target.id, {
			home,
			platform: "linux",
			wslDistro: "",
		});

		await writeInstructionFile(
			currentConfig,
			{
				id: target.id,
				content: "new",
				expectedRevision: document.revision,
			},
			{ home, platform: "linux", wslDistro: "" },
		);

		expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe("new");
		expect(readFileSync(join(vault, "CLAUDE.md"), "utf8")).toBe("new");
	});

	it("refuses instruction symlinks outside the allowed root", async () => {
		if (process.platform === "win32") return;
		const vault = scratch("instructions-vault");
		const outside = scratch("instructions-outside");
		const home = scratch("instructions-home");
		writeFileSync(join(outside, "shared.md"), "do not replace");
		symlinkSync(join(outside, "shared.md"), join(vault, "AGENTS.md"));
		const currentConfig = config(vault, [], "codex");
		const target = (
			await discoverInstructionFileTargets(currentConfig, {
				home,
				platform: "linux",
				wslDistro: "",
			})
		).find(
			(candidate) =>
				candidate.owner === "vault" && candidate.filename === "AGENTS.md",
		);
		expect(target).toBeDefined();
		if (!target) return;
		const document = await readInstructionFile(currentConfig, target.id, {
			home,
			platform: "linux",
			wslDistro: "",
		});

		await expect(
			writeInstructionFile(
				currentConfig,
				{
					id: target.id,
					content: "replacement",
					expectedRevision: document.revision,
				},
				{ home, platform: "linux", wslDistro: "" },
			),
		).rejects.toThrow("outside its allowed location");
		expect(readFileSync(join(outside, "shared.md"), "utf8")).toBe(
			"do not replace",
		);
	});

	it("rejects target ids from an unconfigured provider family", async () => {
		const vault = scratch("instructions-vault");
		const home = scratch("instructions-home");
		const mixed = config(vault, [], "claude");
		const target = (
			await discoverInstructionFileTargets(mixed, {
				home,
				platform: "linux",
				wslDistro: "",
			})
		).find((candidate) => candidate.filename === "CLAUDE.md");
		expect(target).toBeDefined();
		if (!target) return;

		const codexOnly = config(vault, [], "codex");
		await expect(
			readInstructionFile(codexOnly, target.id, {
				home,
				platform: "linux",
				wslDistro: "",
			}),
		).rejects.toThrow("Unknown instruction file target");
		await expect(
			writeInstructionFile(
				codexOnly,
				{ id: target.id, content: "stale", expectedRevision: null },
				{ home, platform: "linux", wslDistro: "" },
			),
		).rejects.toThrow("Unknown instruction file target");
	});
});
