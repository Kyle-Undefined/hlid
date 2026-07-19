import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolveExecutionContextOptions } from "./executionContext";
import { resolveExecutionContext } from "./executionContext";
import { artifactPath, managedSkillsDirectory } from "./libraryStore";

let vault: string;
let agent1: string;
let agent2: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "hlid-vault-"));
	agent1 = mkdtempSync(join(tmpdir(), "hlid-agent1-"));
	agent2 = mkdtempSync(join(tmpdir(), "hlid-agent2-"));
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	rmSync(agent1, { recursive: true, force: true });
	rmSync(agent2, { recursive: true, force: true });
});

function base(
	overrides: Partial<ResolveExecutionContextOptions> = {},
): ResolveExecutionContextOptions {
	return {
		agentMode: "cwd",
		agentCwd: undefined,
		vaultPath: vault,
		allowedAgentRealPaths: [agent1],
		claudeExecutable: "/usr/local/bin/claude",
		safeAttachments: [],
		...overrides,
	};
}

// ── activeCwd ────────────────────────────────────────────────────────────────

describe("resolveExecutionContext — activeCwd", () => {
	it("uses vault when no agentCwd", () => {
		const { activeCwd } = resolveExecutionContext(base());
		expect(activeCwd).toBe(vault);
	});

	it("uses agentCwd in cwd mode", () => {
		const { activeCwd } = resolveExecutionContext(
			base({ agentMode: "cwd", agentCwd: agent1 }),
		);
		expect(activeCwd).toBe(agent1);
	});

	it("uses vault in context mode even with agentCwd", () => {
		const { activeCwd } = resolveExecutionContext(
			base({ agentMode: "context", agentCwd: agent1 }),
		);
		expect(activeCwd).toBe(vault);
	});
});

// ── extraDirs ────────────────────────────────────────────────────────────────

describe("resolveExecutionContext — extraDirs", () => {
	it("empty when no agentCwd (vault-only session)", () => {
		const { extraDirs } = resolveExecutionContext(base());
		expect(extraDirs.size).toBe(0);
	});

	it("includes vault when cwd mode + agentCwd set", () => {
		const { extraDirs } = resolveExecutionContext(
			base({ agentMode: "cwd", agentCwd: agent1 }),
		);
		expect([...extraDirs].some((d) => basename(d) === basename(vault))).toBe(
			true,
		);
	});

	it("includes agentCwd when context mode", () => {
		const { extraDirs } = resolveExecutionContext(
			base({ agentMode: "context", agentCwd: agent1 }),
		);
		expect([...extraDirs]).toContain(agent1);
	});

	it("adds agent root to extraDirs when attachment is from different agent", () => {
		const attPath = join(agent2, "file.txt");
		writeFileSync(attPath, "content");
		const { extraDirs } = resolveExecutionContext(
			base({
				agentMode: "cwd",
				agentCwd: agent1,
				allowedAgentRealPaths: [agent1, agent2],
				safeAttachments: [
					{
						id: "a1",
						path: attPath,
						filename: "file.txt",
						mime: "text/plain",
						kind: "ephemeral",
					},
				],
			}),
		);
		expect([...extraDirs]).toContain(agent2);
	});

	it("does not add current agent to extraDirs for its own attachments", () => {
		const attPath = join(agent1, "file.txt");
		writeFileSync(attPath, "content");
		const { extraDirs } = resolveExecutionContext(
			base({
				agentMode: "cwd",
				agentCwd: agent1,
				allowedAgentRealPaths: [agent1],
				safeAttachments: [
					{
						id: "a1",
						path: attPath,
						filename: "file.txt",
						mime: "text/plain",
						kind: "ephemeral",
					},
				],
			}),
		);
		// vault is in extraDirs for cwd+agentCwd, but agent1 itself is not added again
		expect([...extraDirs]).not.toContain(agent1);
	});

	it("grants only exact Hlid-owned artifact and skill package directories", () => {
		const artifact = artifactPath("artifact-1", "report.html");
		const skill = join(managedSkillsDirectory(), "review", "SKILL.md");
		const { extraDirs } = resolveExecutionContext(
			base({
				safeAttachments: [
					{
						id: "artifact-1",
						path: artifact,
						filename: "report.html",
						mime: "text/html",
						kind: "ephemeral",
					},
				],
				resourcePaths: [artifact, skill],
			}),
		);
		expect([...extraDirs]).toContain(join(managedSkillsDirectory(), "review"));
		expect([...extraDirs]).toContain(join(dirname(artifact)));
		expect([...extraDirs]).not.toContain(managedSkillsDirectory());
	});
});

// ── executable ───────────────────────────────────────────────────────────────

describe("resolveExecutionContext — executable", () => {
	it("passes through claudeExecutable on non-WSL paths", () => {
		const { executable } = resolveExecutionContext(base());
		expect(executable).toBe("/usr/local/bin/claude");
	});

	it("passes through undefined claudeExecutable", () => {
		const { executable } = resolveExecutionContext(
			base({ claudeExecutable: undefined }),
		);
		expect(executable).toBeUndefined();
	});
});
