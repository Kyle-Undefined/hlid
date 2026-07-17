import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

// When running as a compiled exe, resolve data files relative to the exe dir
// so the Windows Run-key CWD (System32) doesn't break config/DB paths.
const _exe = basename(process.execPath);
export const APP_DIR =
	_exe !== "bun" && _exe !== "bun.exe"
		? dirname(process.execPath)
		: process.cwd();

/** Canonical path to `hlid.config.toml`. Single source of truth — import this instead of re-computing. */
export const CONFIG_PATH = resolve(APP_DIR, "hlid.config.toml");

const isWindows = process.platform === "win32";

function parseWslUncSyntax(
	p: string,
): { distro: string; posixPath: string } | null {
	const m = p.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.*)$/i);
	if (!m) return null;
	const distro = m[1];
	const rest = m[2].replace(/\\/g, "/");
	return { distro, posixPath: `/${rest}` };
}

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\"))
		return resolve(homedir(), p.slice(2));
	return p;
}

// Canonical form for path comparison. Resolves to absolute; on Windows also
// normalizes to backslash separator and lowercases (paths are case-insensitive).
// Use only for comparisons — never expose the canonical form to fs APIs that
// might be sensitive to casing in a UNC share name.
export function canonical(p: string): string {
	const r = resolve(p);
	if (!isWindows) return r;
	return r.replace(/\//g, "\\").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
	return canonical(a) === canonical(b);
}

// True if `child` equals `parent` or sits beneath it. Uses platform sep boundary
// so `/foo/barbaz` is not treated as inside `/foo/bar`.
export function pathStartsWith(parent: string, child: string): boolean {
	const p = canonical(parent);
	const c = canonical(child);
	if (c === p) return true;
	const prefix = p.endsWith(sep) ? p : p + sep;
	return c.startsWith(prefix);
}

// Parse a Windows UNC path that points into a WSL distro.
// `\\wsl$\Ubuntu\home\kyle\proj` or `\\wsl.localhost\Ubuntu\home\kyle\proj`
// → { distro: "Ubuntu", posixPath: "/home/kyle/proj" }.
// Returns null for any non-WSL or non-Windows input.
export function parseWslUnc(
	p: string,
): { distro: string; posixPath: string } | null {
	if (!isWindows) return null;
	return parseWslUncSyntax(p);
}

// Translate a host-fs path into the form an in-WSL process expects.
// Windows UNC `\\wsl$\<distro>\...` or `\\wsl.localhost\<distro>\...` → POSIX `/...`.
// Anything else (Windows-native `C:\...`, plain POSIX) is returned as-is.
// Use this only when emitting paths to a Claude process running inside WSL —
// never for fs APIs on the host.
export function toLogical(p: string): string {
	const parsed = parseWslUnc(p);
	return parsed ? parsed.posixPath : p;
}

/**
 * Translate a host path for the provider process that owns `runtimeCwd`.
 * A WSL-backed CLI needs both WSL UNC paths and Windows drive paths expressed
 * in Linux form; native Windows and ordinary POSIX runtimes keep host paths.
 */
export function toProviderRuntimePath(runtimeCwd: string, p: string): string {
	if (!parseWslUncSyntax(runtimeCwd)) return p;
	const wslPath = parseWslUncSyntax(p);
	if (wslPath) return wslPath.posixPath;
	const drivePath = p.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!drivePath) return p;
	const drive = drivePath[1].toLowerCase();
	const rest = drivePath[2].replace(/\\/g, "/");
	return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}
