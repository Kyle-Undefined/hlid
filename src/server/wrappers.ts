import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "../config";
import { APP_DIR, parseWslUnc } from "../lib/paths";

// Wrappers live alongside hlid.config.toml so they're co-located with the
// agent definitions that produce them.
const WRAPPERS_DIR = resolve(APP_DIR, "wrappers");

function wrapperFilename(agentPath: string): string {
	const hash = createHash("sha256")
		.update(agentPath)
		.digest("hex")
		.slice(0, 16);
	return `${hash}.cmd`;
}

export function wrapperPathForAgent(agentPath: string): string {
	return join(WRAPPERS_DIR, wrapperFilename(agentPath));
}

// WSL distro names per Microsoft are alphanumeric plus a small set of
// punctuation. Reject anything else so attacker-controlled config can't smuggle
// shell metacharacters into the generated .cmd.
const DISTRO_RE = /^[A-Za-z0-9._-]+$/;

// POSIX paths may contain spaces and most punctuation, but `"`, CR, LF, and
// NUL would either break batch quoting or split the command line. Reject them
// rather than try to escape — these characters are not legitimate in a path
// users would actually pick from the WSL folder browser.
export function isSafePosixPath(p: string): boolean {
	return !/["\r\n\0]/.test(p);
}

export function wrapperContent(distro: string, posixPath: string): string {
	if (!DISTRO_RE.test(distro)) {
		throw new Error(`Invalid WSL distro name: ${JSON.stringify(distro)}`);
	}
	if (!isSafePosixPath(posixPath)) {
		throw new Error(
			`Unsafe characters in WSL path: ${JSON.stringify(posixPath)}`,
		);
	}
	// %SystemRoot% is set by Windows for every process; safer than relying on PATH.
	// bash -l sources the login profile (~/.profile) so user PATH additions that
	// live there (bun, opencode, etc.) become visible to claude and every
	// subprocess it spawns. Interactive-only setup (aliases, prompt) stays in
	// ~/.bashrc behind the standard non-interactive guard.
	//
	// Single-quoted bash -c string passes through CMD unchanged; "$@" preserves arg boundaries.
	return [
		"@echo off",
		`"%SystemRoot%\\System32\\wsl.exe" -d ${distro} --cd "${posixPath}" -- bash -l -c 'claude "$@"' -- %*`,
		"",
	].join("\r\n");
}

function ensureWrappersDir(): void {
	mkdirSync(WRAPPERS_DIR, { recursive: true });
}

// Write a wrapper for one WSL agent. Returns null if the path isn't a WSL UNC
// or if the parsed distro/path fail safety validation (caller should fall back
// to the default Claude executable).
export function writeWrapper(agentPath: string): string | null {
	const parsed = parseWslUnc(agentPath);
	if (!parsed) return null;
	let body: string;
	try {
		body = wrapperContent(parsed.distro, parsed.posixPath);
	} catch (err) {
		console.warn("[wrappers] refusing to write wrapper:", err);
		return null;
	}
	ensureWrappersDir();
	const target = wrapperPathForAgent(agentPath);
	writeFileSync(target, body, "utf-8");
	return target;
}

// Reconcile the wrappers directory with the current agent list:
// write a wrapper for every WSL agent, remove any .cmd files that no longer
// correspond to a registered WSL agent. Safe to call repeatedly.
export function syncWrappers(agents: Agent[]): void {
	ensureWrappersDir();
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
		writeFileSync(join(WRAPPERS_DIR, filename), body, "utf-8");
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
