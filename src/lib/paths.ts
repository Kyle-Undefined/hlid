import { homedir, tmpdir } from "node:os";
import { basename, dirname, posix, resolve, sep } from "node:path";

// When running as a compiled exe, resolve data files relative to the exe dir
// so the Windows Run-key CWD (System32) doesn't break config/DB paths.
const _exe = basename(process.execPath);
export const APP_DIR = /^hlid(?:-.+)?(?:\.exe)?$/i.test(_exe)
	? dirname(process.execPath)
	: process.cwd();

/** Canonical path to `hlid.config.toml`. Single source of truth — import this instead of re-computing. */
export const CONFIG_PATH = resolve(APP_DIR, "hlid.config.toml");

/** Optional effective-dated pricing overrides, managed from Forge > Developer. */
export const PRICING_OVERRIDES_PATH = resolve(
	APP_DIR,
	"pricing-overrides.toml",
);

/** Hlid-owned CLIProxy binaries, credentials, and provider auth files. */
export const CLIPROXY_DIR = resolve(APP_DIR, "integrations", "cliproxy");

/** Hlid-owned durable content. Repositories and vaults remain linked sources. */
export const LIBRARY_DIR =
	process.env.NODE_ENV === "test"
		? resolve(tmpdir(), "hlid-test-library")
		: resolve(APP_DIR, "library");

const isWindows = process.platform === "win32";

export function parseWslUncSyntax(
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
	const runtime = parseWslUncSyntax(runtimeCwd);
	if (!runtime) return p;
	const wslPath = parseWslUncSyntax(p);
	// UNC paths are only meaningful inside the distro they name. Returning a
	// POSIX path for another distro would silently grant the wrong resource.
	if (wslPath) {
		return wslPath.distro.toLowerCase() === runtime.distro.toLowerCase()
			? wslPath.posixPath
			: p;
	}
	const drivePath = p.match(/^([A-Za-z]):[\\/](.*)$/);
	if (!drivePath) return p;
	const drive = drivePath[1].toLowerCase();
	const rest = drivePath[2].replace(/\\/g, "/");
	return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * Translate a provider-visible path back into the filesystem form used by the
 * Hlid host. Relative paths resolve against the provider's working directory.
 * A WSL-backed provider reports POSIX paths, while the Windows Hlid process
 * needs the matching UNC path to copy the generated file into managed storage.
 */
export function toHostRuntimePath(runtimeCwd: string, p: string): string {
	const runtime = parseWslUncSyntax(runtimeCwd);
	if (!runtime) return resolve(runtimeCwd, p);

	const existingUnc = parseWslUncSyntax(p);
	if (existingUnc) return p;
	if (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) return p;

	const share = runtimeCwd.match(
		/^(\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+)/i,
	)?.[1];
	if (!share) return p;
	const logical = p.startsWith("/")
		? posix.normalize(p)
		: posix.resolve(runtime.posixPath, p);
	return `${share}\\${logical.slice(1).replaceAll("/", "\\")}`;
}

/** Reject WSL UNC resources owned by a distro other than the active runtime. */
export function isPathAccessibleFromRuntime(
	runtimeCwd: string,
	p: string,
): boolean {
	const runtime = parseWslUncSyntax(runtimeCwd);
	const resource = parseWslUncSyntax(p);
	return !(
		runtime &&
		resource &&
		runtime.distro.toLowerCase() !== resource.distro.toLowerCase()
	);
}
