import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findAgentInstructionFile,
	readAgentInstructions,
	readAgentInstructionsAsync,
} from "./agentInstructions";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "hlid-agent-instructions-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("agent instruction files", () => {
	it("returns null when neither supported file exists", () => {
		expect(findAgentInstructionFile(agentDir)).toBeNull();
		expect(readAgentInstructions(agentDir)).toBeNull();
	});

	it("reads AGENTS.md when it is available", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "# Codex persona");
		expect(readAgentInstructions(agentDir)).toEqual({
			filename: "AGENTS.md",
			content: "# Codex persona",
		});
	});

	it("reads AGENTS.md asynchronously for navigation-safe callers", async () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "# Async persona");
		await expect(readAgentInstructionsAsync(agentDir)).resolves.toEqual({
			filename: "AGENTS.md",
			content: "# Async persona",
		});
	});

	it("prefers AGENTS.md when both files exist", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "# Generic persona");
		writeFileSync(join(agentDir, "CLAUDE.md"), "# Existing persona");
		expect(readAgentInstructions(agentDir)).toEqual({
			filename: "AGENTS.md",
			content: "# Generic persona",
		});
	});
});
