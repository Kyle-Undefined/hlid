import { describe, expect, it } from "vitest";
import {
	isClaudeRuntimeProvider,
	isCodexRuntimeProvider,
} from "./providerRuntime";

describe("provider runtime routing", () => {
	it("maps CLIProxy harnesses to their native runtime", () => {
		expect(isClaudeRuntimeProvider("cliproxy-codex")).toBe(true);
		expect(isCodexRuntimeProvider("cliproxy:codex")).toBe(true);
		expect(isClaudeRuntimeProvider("cliproxy:codex")).toBe(false);
		expect(isCodexRuntimeProvider("cliproxy-codex")).toBe(false);
	});
});
