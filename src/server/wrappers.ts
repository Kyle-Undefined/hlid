import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "../config";
import { APP_DIR, parseWslUnc } from "../lib/paths";

// Wrappers live alongside hlid.config.toml so they are co-located with the
// agent definitions that produce them.
const WRAPPERS_DIR = resolve(APP_DIR, "wrappers");

function wrapperFilename(agentPath: string, command = "claude"): string {
	const hash = createHash("sha256")
		.update(`${command}:${agentPath}`)
		.digest("hex")
		.slice(0, 16);
	return `${hash}.cmd`;
}

export function wrapperPathForAgent(
	agentPath: string,
	command = "claude",
): string {
	return join(WRAPPERS_DIR, wrapperFilename(agentPath, command));
}

// WSL distro names per Microsoft are alphanumeric plus a small set of
// punctuation. Reject anything else so attacker-controlled config cannot smuggle
// shell metacharacters into the generated .cmd.
const DISTRO_RE = /^[A-Za-z0-9._-]+$/;

// POSIX paths may contain spaces and most punctuation, but double quotes, CR, LF,
// and NUL would either break batch quoting or split the command line. Reject them
// rather than try to escape characters users would not pick from the WSL folder browser.
export function isSafePosixPath(p: string): boolean {
	return !/["\r\n\0]/.test(p);
}

export function wrapperContent(
	distro: string,
	posixPath: string,
	command = "claude",
): string {
	if (!DISTRO_RE.test(distro)) {
		throw new Error(`Invalid WSL distro name: ${JSON.stringify(distro)}`);
	}
	if (!isSafePosixPath(posixPath)) {
		throw new Error(
			`Unsafe characters in WSL path: ${JSON.stringify(posixPath)}`,
		);
	}
	if (!DISTRO_RE.test(command)) {
		throw new Error(`Invalid wrapper command: ${JSON.stringify(command)}`);
	}
	// Build shell-sensitive characters without embedding them directly so wrappers can
	// safely target different agent commands while preserving argument boundaries.
	const dq = String.fromCharCode(34);
	const bs = String.fromCharCode(92);
	const dollar = String.fromCharCode(36);
	return [
		"@echo off",
		"setlocal",
		'if defined ANTHROPIC_BASE_URL set "WSLENV=ANTHROPIC_BASE_URL/u:%WSLENV%"',
		'if defined ANTHROPIC_AUTH_TOKEN set "WSLENV=ANTHROPIC_AUTH_TOKEN/u:%WSLENV%"',
		'if defined HLID_CLIPROXY_API_KEY set "WSLENV=HLID_CLIPROXY_API_KEY/u:%WSLENV%"',
		'if defined OPENCODE_CONFIG_CONTENT set "WSLENV=OPENCODE_CONFIG_CONTENT/u:%WSLENV%"',
		dq +
			"%SystemRoot%" +
			bs +
			"System32" +
			bs +
			"wsl.exe" +
			dq +
			" -d " +
			distro +
			" --cd " +
			dq +
			posixPath +
			dq +
			" --exec bash -l -c " +
			dq +
			command +
			" " +
			bs +
			dq +
			dollar +
			"@" +
			bs +
			dq +
			dq +
			" -- %*",
		"",
	].join("\r\n");
}

function ensureWrappersDir(): void {
	mkdirSync(WRAPPERS_DIR, { recursive: true });
}

// Write a wrapper for one WSL agent. Returns null if the path is not a WSL UNC
// or if the parsed distro/path fail safety validation.
export function writeWrapper(
	agentPath: string,
	command = "claude",
): string | null {
	const parsed = parseWslUnc(agentPath);
	if (!parsed) return null;
	let body: string;
	try {
		body = wrapperContent(parsed.distro, parsed.posixPath, command);
	} catch (err) {
		console.warn("[wrappers] refusing to write wrapper:", err);
		return null;
	}
	try {
		ensureWrappersDir();
		const target = wrapperPathForAgent(agentPath, command);
		writeFileSync(target, body, "utf-8");
		return target;
	} catch (err) {
		console.warn("[wrappers] failed to write wrapper:", err);
		return null;
	}
}

// Reconcile the wrappers directory with the current agent list. Startup sync keeps
// Claude wrappers current; Codex wrappers are written on demand by execution context.
export function syncWrappers(agents: Agent[]): void {
	try {
		ensureWrappersDir();
	} catch (err) {
		console.warn("[wrappers] failed to create wrapper directory:", err);
		return;
	}
	const want = new Set<string>();
	for (const agent of agents) {
		const parsed = parseWslUnc(agent.path);
		if (!parsed) continue;
		let body: string;
		try {
			body = wrapperContent(parsed.distro, parsed.posixPath);
		} catch (err) {
			console.warn("[wrappers] skipping agent:", agent.path, err);
			continue;
		}
		const filename = wrapperFilename(agent.path);
		want.add(filename);
		try {
			writeFileSync(join(WRAPPERS_DIR, filename), body, "utf-8");
		} catch (err) {
			console.warn("[wrappers] failed to update wrapper:", agent.path, err);
		}
	}
	let existing: string[];
	try {
		existing = readdirSync(WRAPPERS_DIR);
	} catch {
		return;
	}
	for (const f of existing) {
		if (!f.endsWith(".cmd")) continue;
		if (want.has(f)) continue;
		try {
			unlinkSync(join(WRAPPERS_DIR, f));
		} catch {
			// best effort
		}
	}
}
