/**
 * Unit tests for WSL wrapper generation.
 * Covers security validation (cmd injection guards) and .cmd output correctness.
 */
import { describe, expect, it } from "vitest";
import {
	isSafePosixPath,
	wrapperContent,
	wrapperPathForAgent,
} from "./wrappers";

// ── isSafePosixPath ───────────────────────────────────────────────────────────

describe("isSafePosixPath", () => {
	it("rejects paths containing double-quote", () => {
		expect(isSafePosixPath('/home/k"yle/project')).toBe(false);
	});

	it("rejects paths containing CR", () => {
		expect(isSafePosixPath("/home/kyle\r/project")).toBe(false);
	});

	it("rejects paths containing LF", () => {
		expect(isSafePosixPath("/home/kyle\n/project")).toBe(false);
	});

	it("rejects paths containing NUL", () => {
		expect(isSafePosixPath("/home/kyle\0/project")).toBe(false);
	});

	it("accepts normal POSIX paths", () => {
		expect(isSafePosixPath("/home/kyle/my project/repo")).toBe(true);
	});

	it("accepts paths with spaces and punctuation", () => {
		expect(isSafePosixPath("/home/kyle/dev/my-app_v2.0/src")).toBe(true);
	});
});

// ── wrapperContent ────────────────────────────────────────────────────────────

describe("wrapperContent", () => {
	it("throws on distro name with shell metacharacters", () => {
		expect(() => wrapperContent("Ubuntu; rm -rf /", "/home/kyle")).toThrow(
			"Invalid WSL distro name",
		);
	});

	it("throws on distro name with spaces", () => {
		expect(() => wrapperContent("Ubuntu Linux", "/home/kyle")).toThrow(
			"Invalid WSL distro name",
		);
	});

	it("throws on distro name with single-quote (batch escape vector)", () => {
		expect(() => wrapperContent("Ubuntu'injected", "/home/kyle")).toThrow(
			"Invalid WSL distro name",
		);
	});

	it("throws on path containing double-quote", () => {
		expect(() => wrapperContent("Ubuntu", '/home/k"yle/project')).toThrow(
			"Unsafe characters in WSL path",
		);
	});

	it("throws on path containing newline", () => {
		expect(() => wrapperContent("Ubuntu", "/home/kyle\nmalicious")).toThrow(
			"Unsafe characters in WSL path",
		);
	});

	it("produces @echo off header", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle/project");
		expect(out).toMatch(/^@echo off\r\n/);
	});

	it("embeds correct distro name in wsl.exe invocation", () => {
		const out = wrapperContent("Ubuntu-22.04", "/home/kyle/project");
		expect(out).toContain("-d Ubuntu-22.04");
	});

	it("embeds posixPath with --cd flag", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle/my project");
		expect(out).toContain('--cd "/home/kyle/my project"');
	});

	it("uses %SystemRoot% for wsl.exe path (no PATH dependency)", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain("%SystemRoot%\\System32\\wsl.exe");
	});

	it("passes args through via %*", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain("%*");
	});

	it("forwards CLIProxy provider environment into WSL", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain("ANTHROPIC_BASE_URL/u:%WSLENV%");
		expect(out).toContain("ANTHROPIC_AUTH_TOKEN/u:%WSLENV%");
		expect(out).toContain("HLID_CLIPROXY_API_KEY/u:%WSLENV%");
	});

	it("uses bash -l so login profile is sourced", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain("--exec bash -l");
	});

	it("bypasses WSL's default shell when forwarding model arguments", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain("--exec bash -l -c");
	});

	it("defaults to launching Claude with forwarded args", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle");
		expect(out).toContain('claude \\"$@\\"');
	});

	it("can launch Codex with forwarded args", () => {
		const out = wrapperContent("Ubuntu", "/home/kyle", "codex");
		expect(out).toContain('codex \\"$@\\"');
	});
});

// ── wrapperPathForAgent ───────────────────────────────────────────────────────

describe("wrapperPathForAgent", () => {
	it("returns a .cmd path", () => {
		expect(wrapperPathForAgent("\\\\wsl$\\Ubuntu\\home\\kyle")).toMatch(
			/\.cmd$/,
		);
	});

	it("is deterministic for the same input", () => {
		const path = "\\\\wsl$\\Ubuntu\\home\\kyle\\project";
		expect(wrapperPathForAgent(path)).toBe(wrapperPathForAgent(path));
	});

	it("produces different paths for different inputs", () => {
		const a = wrapperPathForAgent("\\\\wsl$\\Ubuntu\\home\\alice");
		const b = wrapperPathForAgent("\\\\wsl$\\Ubuntu\\home\\bob");
		expect(a).not.toBe(b);
	});

	it("produces different paths for different commands", () => {
		const path = "agent-path";
		expect(wrapperPathForAgent(path, "claude")).not.toBe(
			wrapperPathForAgent(path, "codex"),
		);
	});

	it("filename portion is 16 hex chars + .cmd", () => {
		const full = wrapperPathForAgent("\\\\wsl$\\Ubuntu\\home\\kyle");
		const filename = full.split(/[/\\]/).at(-1) ?? "";
		expect(filename).toMatch(/^[0-9a-f]{16}\.cmd$/);
	});
});
