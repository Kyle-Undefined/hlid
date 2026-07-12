import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildPromptOptions } from "./promptBuilder";
import { buildPlanHtmlInstructions, buildPrompt } from "./promptBuilder";

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

describe("buildPrompt — basic", () => {
	it("returns user message as prompt with no extras", () => {
		const { prompt, safeAttachments } = buildPrompt(base());
		expect(prompt).toBe("hello");
		expect(safeAttachments).toEqual([]);
	});

	it("empty userMessage still produces valid prompt", () => {
		const { prompt } = buildPrompt(base({ userMessage: "" }));
		expect(prompt).toBe("");
	});
});

// ── skillContext ──────────────────────────────────────────────────────────────

describe("buildPrompt — skillContext", () => {
	it("injects skill read instruction when skillContext is inside vault", () => {
		const skillFile = join(tmp, "skills", "my-skill.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "# Skill");
		const { prompt } = buildPrompt(base({ skillContext: skillFile }));
		expect(prompt).toContain("Please read the skill file");
		expect(prompt).toContain("my-skill.md");
		expect(prompt).toContain("User: hello");
	});

	it("uses (no additional input) when message is empty with skill", () => {
		const skillFile = join(tmp, "skills", "s.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "");
		const { prompt } = buildPrompt(
			base({ skillContext: skillFile, userMessage: "" }),
		);
		expect(prompt).toContain("(no additional input)");
	});

	it("drops skillContext that is outside vault (security check)", () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
		const outsideFile = join(outsideDir, "evil-skill.md");
		writeFileSync(outsideFile, "evil");
		try {
			const { prompt } = buildPrompt(base({ skillContext: outsideFile }));
			// Should NOT inject skill instruction — treat as plain message
			expect(prompt).toBe("hello");
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("drops skillContext when path does not exist (realpathSync throws)", () => {
		const { prompt } = buildPrompt(
			base({ skillContext: join(tmp, "does-not-exist.md") }),
		);
		expect(prompt).toBe("hello");
	});
});

// ── attachments ───────────────────────────────────────────────────────────────

describe("buildPrompt — attachments", () => {
	it("includes attachment inside vault", () => {
		const attPath = join(tmp, "image.png");
		writeFileSync(attPath, "fake-png");
		const { prompt, safeAttachments } = buildPrompt(
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

	it("excludes attachment outside vault and not in allowed agent paths", () => {
		const outsideDir = mkdtempSync(join(tmpdir(), "outside-att-"));
		const outsideFile = join(outsideDir, "secret.txt");
		writeFileSync(outsideFile, "secret");
		try {
			const { safeAttachments } = buildPrompt(
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

	it("includes attachment inside allowed agent path", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-"));
		const attPath = join(agentDir, "notes.txt");
		writeFileSync(attPath, "agent notes");
		try {
			const { safeAttachments } = buildPrompt(
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

	it("excludes attachment with non-existent path (realpathSync throws)", () => {
		const { safeAttachments } = buildPrompt(
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

	it("filters out unsafe attachments but keeps safe ones", () => {
		const safeFile = join(tmp, "safe.txt");
		writeFileSync(safeFile, "ok");
		const { safeAttachments } = buildPrompt(
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

describe("buildPrompt — context mode persona", () => {
	it("injects persona preamble when context mode, no session, CLAUDE.md exists", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = buildPrompt(
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

	it("injects AGENTS.md when it is the available context instruction file", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-agents-"));
		writeFileSync(join(agentDir, "AGENTS.md"), "# Persona");
		try {
			const { prompt } = buildPrompt(
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

	it("prefers AGENTS.md when both context instruction files exist", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-both-"));
		writeFileSync(join(agentDir, "AGENTS.md"), "# Generic persona");
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Existing persona");
		try {
			const { prompt } = buildPrompt(
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

	it("skips persona preamble when claudeSessionId is set (resume = already established)", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-ctx-resume-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = buildPrompt(
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

	it("skips persona preamble when no instruction file exists", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-no-claude-md-"));
		try {
			const { prompt } = buildPrompt(
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

	it("skips persona preamble in cwd mode even with agentCwd", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "agent-cwd-mode-"));
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Persona");
		try {
			const { prompt } = buildPrompt(
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

	it("skips persona preamble when agentCwd is undefined", () => {
		const { prompt } = buildPrompt(
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

describe("buildPrompt — planHtmlInstructions", () => {
	it("appends the instruction block when set", () => {
		const { prompt } = buildPrompt(
			base({ planHtmlInstructions: buildPlanHtmlInstructions("/x/plan.html") }),
		);
		expect(prompt).toContain("hello");
		expect(prompt).toContain("HTML plan documents");
		expect(prompt).toContain("This is a planning-only turn");
		expect(prompt).toContain("/x/plan.html");
	});

	it("omits the block entirely when unset", () => {
		const { prompt } = buildPrompt(base());
		expect(prompt).not.toContain("HTML plan documents");
	});

	it("appends after the skill-context block too", () => {
		const skillFile = join(tmp, "skills", "s.md");
		mkdirSync(join(tmp, "skills"), { recursive: true });
		writeFileSync(skillFile, "# Skill");
		const { prompt } = buildPrompt(
			base({
				skillContext: skillFile,
				planHtmlInstructions: buildPlanHtmlInstructions("/x/plan.html"),
			}),
		);
		expect(prompt).toContain("Please read the skill file");
		expect(prompt).toContain("HTML plan documents");
	});
});

describe("buildPlanHtmlInstructions", () => {
	it("embeds the given path verbatim", () => {
		const text = buildPlanHtmlInstructions("/tmp/foo/plan-1.html");
		expect(text).toContain("/tmp/foo/plan-1.html");
		expect(text).toContain("ExitPlanMode");
	});
});
