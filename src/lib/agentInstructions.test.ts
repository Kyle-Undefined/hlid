import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findAgentInstructionFile,
	instructionFileNameForProvider,
	readAgentInstructions,
} from "./agentInstructions";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "hlid-agent-instructions-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("agent instruction files", () => {
	it("maps Claude to CLAUDE.md and Codex, ACP, and other runtimes to AGENTS.md", () => {
		expect(instructionFileNameForProvider("claude")).toBe("CLAUDE.md");
		expect(instructionFileNameForProvider("cliproxy-codex")).toBe("CLAUDE.md");
		expect(instructionFileNameForProvider("codex")).toBe("AGENTS.md");
		expect(instructionFileNameForProvider("acp:gemini")).toBe("AGENTS.md");
		expect(instructionFileNameForProvider("other")).toBe("AGENTS.md");
	});

	it("returns null when the configured provider file does not exist", () => {
		expect(findAgentInstructionFile(agentDir, "codex")).toBeNull();
		expect(readAgentInstructions(agentDir, "claude")).toBeNull();
	});

	it("reads the configured provider instruction file", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "# Codex persona");
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Claude persona");
		expect(readAgentInstructions(agentDir, "codex")).toEqual({
			filename: "AGENTS.md",
			content: "# Codex persona",
		});
		expect(readAgentInstructions(agentDir, "claude")).toEqual({
			filename: "CLAUDE.md",
			content: "# Claude persona",
		});
	});

	it("preserves AGENTS.md-first discovery when no provider is supplied", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "# Generic persona");
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Claude persona");
		expect(readAgentInstructions(agentDir)).toEqual({
			filename: "AGENTS.md",
			content: "# Generic persona",
		});
	});
});
