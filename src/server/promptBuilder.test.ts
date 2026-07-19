import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildPromptOptions } from "./promptBuilder";
import { buildPlanHtmlInstructions, buildPromptAsync } from "./promptBuilder";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "hlid-prompt-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function base(overrides: Partial<BuildPromptOptions> = {}): BuildPromptOptions {
	return {
		vaultPath: tmp,
		allowedAgentRealPaths: [],
		agentMode: "cwd",
		agentCwd: undefined,
		claudeSessionId: null,
		userMessage: "hello",
		skillContext: undefined,
		attachments: undefined,
		...overrides,
	};
}

// ── basic prompt ──────────────────────────────────────────────────────────────

describe("buildPrompt — basic", async () => {
	it("returns user message as prompt with no extras", async () => {
		const { prompt, safeAttachments } = await buildPromptAsync(base());
		expect(prompt).toBe("hello");
		expect(safeAttachments).toEqual([]);
	});

	it("empty userMessage still produces valid prompt", async () => {
		const { prompt } = await buildPromptAsync(base({ userMessage: "" }));
		expect(prompt).toBe("");
	});
});

describe("buildPrompt — vault references", async () => {
	it("resolves selected relative paths into exact provider instructions", async () => {
		mkdirSync(join(tmp, "Projects"), { recursive: true });
		writeFileSync(join(tmp, "Projects", "Hlid.md"), "# Hlid");
		const result = await buildPromptAsync(
			base({ vaultReferences: ["Projects/Hlid.md"] }),
		);
		expect(result.prompt).toContain(
			"Vault references (read or edit these exact files when relevant)",
		);
		expect(result.prompt).toContain(join(tmp, "Projects", "Hlid.md"));
		expect(result.prompt).toContain("(Vault: Projects/Hlid.md)");
		expect(result.safeVaultReferences).toEqual([
			{
				relativePath: "Projects/Hlid.md",
				path: join(tmp, "Projects", "Hlid.md"),
			},
		]);
		expect(result.resourcePaths).toContain(join(tmp, "Projects", "Hlid.md"));
	});

	it("supports a reference-only prompt and drops unsafe paths", async () => {
		writeFileSync(join(tmp, "Note.md"), "note");
		const result = await buildPromptAsync(
			base({
				userMessage: "",
				vaultReferences: ["Note.md", "../outside.md"],
			}),
		);
		expect(result.prompt).toContain("User: (no additional input)");
		expect(result.safeVaultReferences).toEqual([
			{ relativePath: "Note.md", path: join(tmp, "Note.md") },
		]);
		expect(result.prompt).not.toContain("outside.md");
	});
});

// ── skillContext ──────────────────────────────────────────────────────────────

describe("buildPrompt — skillContext", async () => {
	it("injects every valid selected skill", async () => {
		const first = join(tmp, "skills", "first.md");
		const second = join(tmp, "skills", "second.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(first, "# First");
		writeFileSync(second, "# Second");
		const { prompt } = await buildPromptAsync(
			base({ skillContexts: [first, second] }),
		);
		expect(prompt).toContain("following skill files");
		expect(prompt).toContain("first.md");
		expect(prompt).toContain("second.md");
	});

	it("keeps a provider slash command at the prompt prefix with vault skills", async () => {
		const skillFile = join(tmp, "skills", "review.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "# Review");
		const { prompt } = await buildPromptAsync(
			base({ skillContexts: [skillFile], userMessage: "/test focused" }),
		);
		expect(prompt.startsWith("/test focused")).toBe(true);
		expect(prompt).toContain("review.md");
	});

	it("injects skill read instruction when skillContext is inside vault", async () => {
		const skillFile = join(tmp, "skills", "my-skill.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "# Skill");
		const { prompt } = await buildPromptAsync(
			base({ skillContext: skillFile }),
		);
		expect(prompt).toContain("Please read the skill file");
		expect(prompt).toContain("my-skill.md");
		expect(prompt).toContain("User: hello");
	});

	it("uses (no additional input) when message is empty with skill", async () => {
		const skillFile = join(tmp, "skills", "s.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "");
		const { prompt } = await buildPromptAsync(
			base({ skillContext: skillFile, userMessage: "" }),
		);
		expect(prompt).toContain("(no additional input)");
	});

	it("drops skillContext that is outside vault (security check)", async () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
		const outsideFile = join(outsideDir, "evil-skill.md");
		writeFileSync(outsideFile, "evil");
		try {
			const { prompt } = await buildPromptAsync(
				base({ skillContext: outsideFile }),
			);
			// Should NOT inject skill instruction — treat as plain message
			expect(prompt).toBe("hello");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("drops skillContext when path does not exist", async () => {
		const { prompt } = await buildPromptAsync(
			base({ skillContext: join(tmp, "does-not-exist.md") }),
		);
		expect(prompt).toBe("hello");
	});
});

// ── attachments ───────────────────────────────────────────────────────────────

describe("buildPrompt — attachments", async () => {
	it("includes attachment inside vault", async () => {
		const attPath = join(tmp, "image.png");
		writeFileSync(attPath, "fake-png");
		const { prompt, safeAttachments } = await buildPromptAsync(
			base({
				attachments: [
					{
						id: "a1",
						path: attPath,
						filename: "image.png",
						mime: "image/png",
						kind: "vault",
					},
				],
			}),
		);
		expect(safeAttachments).toHaveLength(1);
		expect(prompt).toContain("image.png");
		expect(prompt).toContain("Attachments");
	});

	it("excludes attachment outside vault and not in allowed agent paths", async () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "outside-att-"));
		const outsideFile = join(outsideDir, "secret.txt");
		writeFileSync(outsideFile, "secret");
		try {
			const { safeAttachments } = await buildPromptAsync(
				base({
					attachments: [
						{
							id: "a1",
							path: outsideFile,
							filename: "secret.txt",
							mime: "text/plain",
							kind: "ephemeral",
						},
					],
				}),
			);
			expect(safeAttachments).toHaveLength(0);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("includes attachment inside allowed agent path", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const attPath = join(agentDir, "notes.txt");
		writeFileSync(attPath, "agent notes");
		try {
			const { safeAttachments } = await buildPromptAsync(
				base({
					allowedAgentRealPaths: [resolve(agentDir)],
					attachments: [
						{
							id: "a2",
							path: attPath,
							filename: "notes.txt",
							mime: "text/plain",
							kind: "ephemeral",
						},
					],
				}),
			);
			expect(safeAttachments).toHaveLength(1);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("excludes attachment with non-existent path", async () => {
		const { safeAttachments } = await buildPromptAsync(
			base({
				attachments: [
					{
						id: "a3",
						path: join(tmp, "ghost.png"),
						filename: "ghost.png",
						mime: "image/png",
						kind: "ephemeral",
					},
				],
			}),
		);
		expect(safeAttachments).toHaveLength(0);
	});

	it("filters out unsafe attachments but keeps safe ones", async () => {
		const safeFile = join(tmp, "safe.txt");
		writeFileSync(safeFile, "ok");
		const { safeAttachments } = await buildPromptAsync(
			base({
				attachments: [
					{
						id: "a1",
						path: safeFile,
						filename: "safe.txt",
						mime: "text/plain",
						kind: "vault",
					},
					{
						id: "a2",
						path: "/etc/shadow",
						filename: "shadow",
						mime: "text/plain",
						kind: "ephemeral",
					},
				],
			}),
		);
		expect(safeAttachments).toHaveLength(1);
		expect(safeAttachments[0].id).toBe("a1");
	});
});

// ── context mode persona preamble ─────────────────────────────────────────────

describe("buildPrompt — context mode persona", async () => {
	it("injects persona preamble when context mode, no session, CLAUDE.md exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "context",
					agentCwd: agentDir,
					claudeSessionId: null,
				}),
			);
			expect(prompt).toContain("CLAUDE.md");
			expect(prompt).toContain("adopt its persona");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("injects AGENTS.md when it is the available context instruction file", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-agents-"));
		writeFileSync(join(agentDir, "AGENTS.md"), "# Persona");
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "context",
					agentCwd: agentDir,
					claudeSessionId: null,
				}),
			);
			expect(prompt).toContain("AGENTS.md");
			expect(prompt).toContain("adopt its persona");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("prefers AGENTS.md when both context instruction files exist", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-both-"));
		writeFileSync(join(agentDir, "AGENTS.md"), "# Generic persona");
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Existing persona");
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "context",
					agentCwd: agentDir,
					claudeSessionId: null,
				}),
			);
			expect(prompt).toContain("AGENTS.md");
			expect(prompt).not.toContain("CLAUDE.md");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips persona preamble when claudeSessionId is set (resume = already established)", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-resume-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "context",
					agentCwd: agentDir,
					claudeSessionId: "existing-session-id",
				}),
			);
			expect(prompt).not.toContain("adopt its persona");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips persona preamble when no instruction file exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-no-claude-md-"));
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "context",
					agentCwd: agentDir,
					claudeSessionId: null,
				}),
			);
			expect(prompt).not.toContain("adopt its persona");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips persona preamble in cwd mode even with agentCwd", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-cwd-mode-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = await buildPromptAsync(
				base({
					agentMode: "cwd",
					agentCwd: agentDir,
					claudeSessionId: null,
				}),
			);
			expect(prompt).not.toContain("adopt its persona");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("skips persona preamble when agentCwd is undefined", async () => {
		const { prompt } = await buildPromptAsync(
			base({
				agentMode: "context",
				agentCwd: undefined,
				claudeSessionId: null,
			}),
		);
		expect(prompt).not.toContain("adopt its persona");
	});
});

// ── plan HTML instructions ────────────────────────────────────────────────────

describe("buildPrompt — planHtmlInstructions", async () => {
	it("appends the instruction block when set", async () => {
		const { prompt } = await buildPromptAsync(
			base({ planHtmlInstructions: buildPlanHtmlInstructions("/x/plan.html") }),
		);
		expect(prompt).toContain("hello");
		expect(prompt).toContain("HTML plan documents");
		expect(prompt).toContain("This is a planning-only turn");
		expect(prompt).toContain("/x/plan.html");
	});

	it("omits the block entirely when unset", async () => {
		const { prompt } = await buildPromptAsync(base());
		expect(prompt).not.toContain("HTML plan documents");
	});

	it("appends after the skill-context block too", async () => {
		const skillFile = join(tmp, "skills", "s.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "# Skill");
		const { prompt } = await buildPromptAsync(
			base({
				skillContext: skillFile,
				planHtmlInstructions: buildPlanHtmlInstructions("/x/plan.html"),
			}),
		);
		expect(prompt).toContain("Please read the skill file");
		expect(prompt).toContain("HTML plan documents");
	});
});

describe("buildPlanHtmlInstructions", async () => {
	it("embeds the given path verbatim", async () => {
		const text = buildPlanHtmlInstructions("/tmp/foo/plan-1.html");
		expect(text).toContain("/tmp/foo/plan-1.html");
		expect(text).toContain("ExitPlanMode");
	});
});
