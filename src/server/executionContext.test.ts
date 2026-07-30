import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveExecutionContextOptions } from "./executionContext";
import {
	normalizeProviderCwd,
	resolveExecutionContext,
	windowsWslHostPathFromRoot,
} from "./executionContext";
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

describe("resolveExecutionContext — bare POSIX paths on Windows", () => {
	const wslRoot = "\\\\wsl.localhost\\Ubuntu-24.04\\";
	const vaultPosix = "/home/kyle/vault-test";
	const vaultUnc = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault-test";

	it("maps a POSIX path under the default distro UNC root", () => {
		expect(windowsWslHostPathFromRoot(vaultPosix, wslRoot)).toBe(vaultUnc);
		expect(
			windowsWslHostPathFromRoot("/home/kyle/work/../vault-test", wslRoot),
		).toBe(vaultUnc);
	});

	it("refuses ambiguous, relative, and unsafe path syntax", () => {
		expect(windowsWslHostPathFromRoot("home/kyle", wslRoot)).toBeNull();
		expect(windowsWslHostPathFromRoot("//server/share", wslRoot)).toBeNull();
		expect(windowsWslHostPathFromRoot('/home/k"yle', wslRoot)).toBeNull();
	});

	it("keeps native Windows and non-Windows paths unchanged", () => {
		const resolveWsl = vi.fn(() => vaultUnc);
		expect(
			normalizeProviderCwd("C:\\Users\\kyle\\vault", {
				platform: "win32",
				resolveWindowsWslHostPath: resolveWsl,
			}),
		).toBe("C:\\Users\\kyle\\vault");
		expect(
			normalizeProviderCwd(vaultPosix, {
				platform: "linux",
				resolveWindowsWslHostPath: resolveWsl,
			}),
		).toBe(vaultPosix);
		expect(resolveWsl).not.toHaveBeenCalled();
	});

	it("normalizes an agent-less vault cwd and selects its Claude wrapper", () => {
		const wrapper =
			"C:\\Users\\kyle\\AppData\\Local\\Hlid\\wrappers\\claude.cmd";
		const writeWslWrapper = vi.fn(() => wrapper);
		const resolveWsl = vi.fn(() => vaultUnc);

		const result = resolveExecutionContext(
			base({
				agentMode: "cwd",
				agentCwd: undefined,
				vaultPath: vaultPosix,
				claudeExecutable: "C:\\Program Files\\Claude\\claude.exe",
			}),
			{
				platform: "win32",
				resolveWindowsWslHostPath: resolveWsl,
				existsSync: vi.fn(() => false),
				wrapperPathForAgent: vi.fn(() => wrapper),
				writeWrapper: writeWslWrapper,
			},
		);

		expect(result.activeCwd).toBe(vaultUnc);
		expect(result.executable).toBe(wrapper);
		expect(writeWslWrapper).toHaveBeenCalledWith(vaultUnc, "claude");
	});

	it("normalizes the vault cwd in context mode and exposes the WSL agent directory", () => {
		const agentUnc = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project";
		const wrapper =
			"C:\\Users\\kyle\\AppData\\Local\\Hlid\\wrappers\\claude.cmd";
		const result = resolveExecutionContext(
			base({
				agentMode: "context",
				agentCwd: agentUnc,
				vaultPath: vaultPosix,
			}),
			{
				platform: "win32",
				resolveWindowsWslHostPath: () => vaultUnc,
				existsSync: () => true,
				wrapperPathForAgent: () => wrapper,
			},
		);

		expect(result.activeCwd).toBe(vaultUnc);
		expect(result.extraDirs).toContain(agentUnc);
		expect(result.executable).toBe(wrapper);
	});

	it("preserves the prior native fallback when the default WSL distro is unavailable", () => {
		const result = resolveExecutionContext(
			base({
				vaultPath: vaultPosix,
				claudeExecutable: "C:\\Program Files\\Claude\\claude.exe",
			}),
			{
				platform: "win32",
				resolveWindowsWslHostPath: () => null,
			},
		);

		expect(result.activeCwd).toBe(vaultPosix);
		expect(result.executable).toBe("C:\\Program Files\\Claude\\claude.exe");
	});
});
