// Self-update flow.
//
// Happy path:
//   1. UI hits GET /api/updates → getStatus() → reads on-disk cache; if stale
//      (>24h or missing) and the network is reachable, refreshes from
//      GitHub's unauthenticated releases/latest.
//   2. UI hits POST /api/updates {action:"download"} → downloadUpdate()
//      streams the versioned exe + checksums file into the staging dir,
//      then verifyChecksum() validates the binary's SHA-256.
//   3. UI hits POST /api/updates {action:"apply"} → applyUpdate() opens
//      the server-held, reverified staged exe via the Windows shell, the
//      same code path as a user double-clicking the file in Explorer.
//      The running canonical stays up. The staged exe — once the user
//      clicks through any SmartScreen prompt — runs maybeSelfInstall,
//      which posts /api/lifecycle shutdown to the running canonical,
//      waits for it to exit, copies itself to the canonical path, and
//      relaunches with --restart.
//
// Why ShellExecute via explorer.exe (vs. an in-process install or a chained
// `Bun.spawn` of the staged exe):
//   SmartScreen prompts only surface when a launch comes from an
//   interactive shell context. Programmatic CreateProcess paths
//   (Bun.spawn, hidden PowerShell, detached cmd /c start) silently
//   swallow the dialog when the staged binary has no reputation, and
//   the launch fails with no feedback to the user. Routing through
//   explorer ensures the prompt renders, the user can click through,
//   and the existing maybeSelfInstall path takes over from there.
//
// Why unauthenticated GitHub:
//   Repo is OSS. Embedding a PAT in the binary would be extracted within
//   minutes. Unauth is 60 req/hr/IP; with a 24h cache + page-load-only
//   checks, a single user burns ~0.04 req/hr.

import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalInstallDir } from "./install";
import { CURRENT_VERSION } from "./version";

const REPO_OWNER = "Kyle-Undefined";
const REPO_NAME = "hlid";
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const USER_AGENT = `hlid-updater/${CURRENT_VERSION}`;
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Conservative caps. Real releases land around 90 MB; this leaves headroom
// while rejecting obvious garbage (a 5 GB redirect target, etc.).
const MAX_EXE_BYTES = 500 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;

type UpdateCache = {
	lastCheckedAt: number;
	latestVersion: string | null;
	latestExeUrl: string | null;
	latestExeName: string | null;
	latestChecksumUrl: string | null;
	etag: string | null;
};

export type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	error?: string;
};

export type ActionResult<T = unknown> =
	| { ok: true; data?: T }
	| { ok: false; error: string };

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseResponse = {
	tag_name: string;
	prerelease?: boolean;
	assets: ReleaseAsset[];
};

type VerifiedArtifact = {
	path: string;
	digest: string;
	version: string;
};

// This capability is intentionally held only by the server process. The HTTP
// client may ask to apply the most recently verified download, but it cannot
// select a filesystem path for execution.
let verifiedArtifact: VerifiedArtifact | null = null;

function stagingDir(): string {
	return join(canonicalInstallDir(), "updates");
}

function cachePath(): string {
	return join(canonicalInstallDir(), "update-cache.json");
}

function tryUnlink(p: string): void {
	try {
		unlinkSync(p);
	} catch {}
}

const EMPTY_CACHE: UpdateCache = {
	lastCheckedAt: 0,
	latestVersion: null,
	latestExeUrl: null,
	latestExeName: null,
	latestChecksumUrl: null,
	etag: null,
};

async function readCache(): Promise<UpdateCache> {
	try {
		const raw = await readFile(cachePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<UpdateCache>;
		return {
			lastCheckedAt: Number(parsed.lastCheckedAt ?? 0) || 0,
			latestVersion: parsed.latestVersion ?? null,
			latestExeUrl: parsed.latestExeUrl ?? null,
			latestExeName: parsed.latestExeName ?? null,
			latestChecksumUrl: parsed.latestChecksumUrl ?? null,
			etag: parsed.etag ?? null,
		};
	} catch {
		return { ...EMPTY_CACHE };
	}
}

async function writeCache(cache: UpdateCache): Promise<void> {
	mkdirSync(canonicalInstallDir(), { recursive: true });
	await writeFile(cachePath(), JSON.stringify(cache, null, 2), "utf8");
}

// Strip a leading "v" so "v0.4.2" and "0.4.2" compare equal.
function normalizeVersion(v: string): string {
	return v.replace(/^v/i, "").trim();
}

// Return >0 if `a` is newer than `b`, <0 if older, 0 if equal.
// Numeric segments compared numerically; trailing prerelease (anything after
// the first "-") makes a version *older* than the same base, matching semver.
// For our use we only ever compare release tags from GitHub against
// package.json — both are clean semver in practice.
function compareVersions(a: string, b: string): number {
	const split = (v: string) => {
		const norm = normalizeVersion(v);
		const dash = norm.indexOf("-");
		const base = dash === -1 ? norm : norm.slice(0, dash);
		const pre = dash === -1 ? "" : norm.slice(dash + 1);
		return {
			parts: base.split(".").map((s) => {
				const n = parseInt(s, 10);
				return Number.isFinite(n) ? n : 0;
			}),
			pre,
		};
	};
	const A = split(a);
	const B = split(b);
	const len = Math.max(A.parts.length, B.parts.length);
	for (let i = 0; i < len; i++) {
		const ai = A.parts[i] ?? 0;
		const bi = B.parts[i] ?? 0;
		if (ai !== bi) return ai - bi;
	}
	// Equal base versions: a prerelease is older than a non-prerelease.
	if (A.pre === B.pre) return 0;
	if (!A.pre) return 1;
	if (!B.pre) return -1;
	return A.pre < B.pre ? -1 : 1;
}

// Fetch the latest non-prerelease and reshape it into our cache row.
// Treats network/4xx/5xx as soft errors: cache untouched, caller still gets
// a UpdateStatus payload from existing cache.
async function fetchLatestRelease(
	prevEtag: string | null,
): Promise<
	| { kind: "ok"; cache: UpdateCache }
	| { kind: "not_modified" }
	| { kind: "error"; error: string }
> {
	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (prevEtag) headers["If-None-Match"] = prevEtag;

	let res: Response;
	try {
		res = await fetch(RELEASES_LATEST_URL, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		return { kind: "error", error: `network: ${(e as Error).message}` };
	}

	if (res.status === 304) return { kind: "not_modified" };
	if (res.status === 403 || res.status === 429) {
		const remaining = res.headers.get("x-ratelimit-remaining");
		return {
			kind: "error",
			error: `rate-limited (remaining=${remaining ?? "?"})`,
		};
	}
	if (!res.ok) {
		return { kind: "error", error: `github ${res.status}` };
	}

	let body: ReleaseResponse;
	try {
		body = (await res.json()) as ReleaseResponse;
	} catch {
		return { kind: "error", error: "bad json from github" };
	}

	// releases/latest already excludes prereleases per GitHub docs, but
	// double-check in case the user manually marks a release latest.
	if (body.prerelease) {
		return { kind: "error", error: "latest release is a prerelease" };
	}

	const exe = body.assets.find((a) =>
		/^hlid-v.+-windows-x64\.exe$/.test(a.name),
	);
	const checksums = body.assets.find((a) => a.name === "hlid-checksums.txt");
	if (!exe || !checksums) {
		return {
			kind: "error",
			error: "release missing exe or checksums asset",
		};
	}

	return {
		kind: "ok",
		cache: {
			lastCheckedAt: Date.now(),
			latestVersion: normalizeVersion(body.tag_name),
			latestExeUrl: exe.browser_download_url,
			latestExeName: exe.name,
			latestChecksumUrl: checksums.browser_download_url,
			etag: res.headers.get("etag"),
		},
	};
}

function statusFromCache(cache: UpdateCache, error?: string): UpdateStatus {
	const latest = cache.latestVersion;
	const available =
		latest != null && compareVersions(latest, CURRENT_VERSION) > 0;
	return {
		current: CURRENT_VERSION,
		latest,
		available,
		lastCheckedAt: cache.lastCheckedAt,
		error,
	};
}

// Read-only view of update status. Used by FORGE on page load. Honors the
// 24h TTL: only hits GitHub when cache is stale. Pass {force:true} to bypass
// (the manual "Check for updates" button does this).
export async function getStatus(opts?: {
	force?: boolean;
}): Promise<UpdateStatus> {
	const cache = await readCache();
	const stale = Date.now() - cache.lastCheckedAt > CHECK_TTL_MS;
	if (!opts?.force && !stale) return statusFromCache(cache);

	const result = await fetchLatestRelease(cache.etag);
	if (result.kind === "not_modified") {
		const updated: UpdateCache = { ...cache, lastCheckedAt: Date.now() };
		await writeCache(updated).catch(() => {});
		return statusFromCache(updated);
	}
	if (result.kind === "error") {
		// Soft fail: keep existing cache intact, surface the error so UI can
		// show "couldn't reach github" without losing the last-known latest.
		return statusFromCache(cache, result.error);
	}
	await writeCache(result.cache).catch(() => {});
	return statusFromCache(result.cache);
}

async function streamToFile(
	body: ReadableStream<Uint8Array>,
	dest: string,
	maxBytes: number,
): Promise<void> {
	let total = 0;
	// Wrap to enforce a hard size cap while streaming.
	const checked = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = body.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > maxBytes) {
						controller.error(new Error(`download exceeded ${maxBytes} bytes`));
						return;
					}
					controller.enqueue(value);
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			} finally {
				reader.releaseLock();
			}
		},
	});
	await pipeline(
		Readable.fromWeb(checked as unknown as import("stream/web").ReadableStream),
		createWriteStream(dest),
	);
}

async function sha256Of(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

// Parse the `sha256sum`-style file shipped with each release:
//   <hex>  <filename>
// Returns the hex digest for `filename` if found, else null.
function checksumFor(text: string, filename: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
		if (!m) continue;
		if (m[2] === filename) return m[1].toLowerCase();
	}
	return null;
}

export async function downloadUpdate(): Promise<
	ActionResult<{ version: string }>
> {
	verifiedArtifact = null;
	const cache = await readCache();
	if (
		!cache.latestVersion ||
		!cache.latestExeUrl ||
		!cache.latestExeName ||
		!cache.latestChecksumUrl
	) {
		return { ok: false, error: "no update info; run check first" };
	}
	if (compareVersions(cache.latestVersion, CURRENT_VERSION) <= 0) {
		return { ok: false, error: "already on latest" };
	}

	const dir = stagingDir();
	mkdirSync(dir, { recursive: true });
	const exePath = join(dir, cache.latestExeName);
	const sumsPath = join(dir, "hlid-checksums.txt");

	// Best-effort cleanup of any prior partial download for the same name.
	tryUnlink(exePath);
	tryUnlink(sumsPath);

	try {
		const exeRes = await fetch(cache.latestExeUrl, {
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(120_000),
		});
		if (!exeRes.ok || !exeRes.body) {
			return { ok: false, error: `download failed: http ${exeRes.status}` };
		}
		await streamToFile(exeRes.body, exePath, MAX_EXE_BYTES);

		const sumsRes = await fetch(cache.latestChecksumUrl, {
			headers: { "User-Agent": USER_AGENT },
			signal: AbortSignal.timeout(15_000),
		});
		if (!sumsRes.ok || !sumsRes.body) {
			return {
				ok: false,
				error: `checksum download failed: http ${sumsRes.status}`,
			};
		}
		await streamToFile(sumsRes.body, sumsPath, MAX_CHECKSUMS_BYTES);
	} catch (e) {
		// Mid-stream failure (network drop, size cap exceeded). Clean up so a
		// retry doesn't run verifyChecksum on a partial file.
		tryUnlink(exePath);
		tryUnlink(sumsPath);
		return { ok: false, error: `download failed: ${(e as Error).message}` };
	}

	const sumsText = await readFile(sumsPath, "utf8");
	const expected = checksumFor(sumsText, cache.latestExeName);
	if (!expected) {
		tryUnlink(exePath);
		return { ok: false, error: "checksum entry missing for downloaded exe" };
	}
	const actual = await sha256Of(exePath);
	if (actual !== expected) {
		tryUnlink(exePath);
		return {
			ok: false,
			error: `checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
		};
	}
	verifiedArtifact = {
		path: exePath,
		digest: expected,
		version: cache.latestVersion,
	};

	return {
		ok: true,
		data: { version: cache.latestVersion },
	};
}

export async function applyUpdate(): Promise<
	ActionResult<{ version: string }>
> {
	const artifact = verifiedArtifact;
	if (!artifact) {
		return { ok: false, error: "no verified staged update; re-download" };
	}
	if (!existsSync(artifact.path)) {
		verifiedArtifact = null;
		return { ok: false, error: "staged exe missing; re-download" };
	}

	let stagedExe: string;
	try {
		const root = realpathSync(stagingDir());
		stagedExe = realpathSync(artifact.path);
		const rel = relative(root, stagedExe);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			verifiedArtifact = null;
			return { ok: false, error: "staged exe escaped update directory" };
		}
		// Resolve once more to make the intended canonical containment explicit
		// before handing the path to the platform shell.
		if (resolve(root, rel) !== stagedExe) {
			verifiedArtifact = null;
			return { ok: false, error: "invalid staged exe path" };
		}
	} catch {
		verifiedArtifact = null;
		return { ok: false, error: "staged exe missing; re-download" };
	}

	const actual = await sha256Of(stagedExe).catch(() => null);
	if (actual !== artifact.digest) {
		verifiedArtifact = null;
		return { ok: false, error: "staged exe checksum changed; re-download" };
	}

	// Open the staged exe via Windows shell — same code path as the user
	// double-clicking the file in Explorer. Crucially this surfaces the
	// SmartScreen prompt (if any) on the user's interactive desktop;
	// programmatic CreateProcess launches (Bun.spawn, hidden PowerShell,
	// detached cmd) get silently suppressed for unsigned binaries.
	//
	// We don't exit here. The staged exe's maybeSelfInstall is what tells
	// us to shut down (POST /api/lifecycle), so the old canonical stays
	// alive until the staged exe is committed to the install. If the user
	// dismisses the SmartScreen prompt instead, nothing happens — the
	// running canonical is unaffected and the user can retry.
	try {
		Bun.spawn(["explorer.exe", stagedExe], {
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
			windowsHide: true,
		});
	} catch (e) {
		return { ok: false, error: `failed to launch: ${(e as Error).message}` };
	}

	return { ok: true, data: { version: artifact.version } };
}

// Best-effort cleanup of the staging dir. Called on boot, after the new
// canonical instance is up, so a successful update doesn't leave the prior
// versioned exe + checksums file lying around forever.
export function cleanupStagingDir(): void {
	verifiedArtifact = null;
	const dir = stagingDir();
	try {
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				try {
					rmSync(join(dir, name), { force: true, recursive: false });
				} catch {}
			}
		}
	} catch {}
}
