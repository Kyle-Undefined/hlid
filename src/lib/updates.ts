// Self-update flow.
//
// Happy path:
//   1. UI hits GET /api/updates → getStatus() → reads on-disk cache; if stale
//      (>24h or missing) and the network is reachable, refreshes from
//      GitHub's unauthenticated releases/latest.
//   2. UI hits POST /api/updates {action:"download"} → downloadUpdate()
//      streams the versioned exe + checksums file into the staging dir,
//      then verifyChecksum() validates the binary's SHA-256.
//   3. UI hits POST /api/updates {action:"apply"} → applyUpdate() spawns
//      the staged exe detached, waits for the staging-ack marker
//      (proves the child reached maybeSelfInstall and is committing),
//      then triggers the regular shutdown path so the child can take
//      over the canonical install in install.ts.
//
// Why this lives entirely in user-space (no installer/stub):
//   maybeSelfInstall (src/lib/install.ts) is already a fully-working
//   "I am a versioned exe, take me canonical" path. The update flow just
//   stages a new versioned exe and runs it — install.ts does the rest.
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
	rmSync,
	unlinkSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalInstallDir } from "./install";
import { shutdown } from "./lifecycle";
import { CURRENT_VERSION } from "./version";

const REPO_OWNER = "Kyle-Undefined";
const REPO_NAME = "hlid";
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const USER_AGENT = `hlid-updater/${CURRENT_VERSION}`;
const CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const STAGING_ACK_FILENAME = ".staging-ack";
const STAGING_ACK_TIMEOUT_MS = 5_000;
const STAGING_POLL_INTERVAL_MS = 100;
// Conservative caps. Real releases land around 90 MB; this leaves headroom
// while rejecting obvious garbage (a 5 GB redirect target, etc.).
const MAX_EXE_BYTES = 500 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;

export type UpdateCache = {
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

function stagingDir(): string {
	return join(canonicalInstallDir(), "updates");
}

function cachePath(): string {
	return join(canonicalInstallDir(), "update-cache.json");
}

export function stagingAckPath(): string {
	return join(canonicalInstallDir(), STAGING_ACK_FILENAME);
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
export function compareVersions(a: string, b: string): number {
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

type ReleaseAsset = { name: string; browser_download_url: string };
type ReleaseResponse = {
	tag_name: string;
	prerelease?: boolean;
	assets: ReleaseAsset[];
};

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
	mkdirSync(stagingDir(), { recursive: true });
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
	ActionResult<{ stagedExe: string; version: string }>
> {
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
	try {
		if (existsSync(exePath)) unlinkSync(exePath);
	} catch {}
	try {
		if (existsSync(sumsPath)) unlinkSync(sumsPath);
	} catch {}

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
		try {
			if (existsSync(exePath)) unlinkSync(exePath);
		} catch {}
		try {
			if (existsSync(sumsPath)) unlinkSync(sumsPath);
		} catch {}
		return { ok: false, error: `download failed: ${(e as Error).message}` };
	}

	const sumsText = await readFile(sumsPath, "utf8");
	const expected = checksumFor(sumsText, cache.latestExeName);
	if (!expected) {
		try {
			unlinkSync(exePath);
		} catch {}
		return { ok: false, error: "checksum entry missing for downloaded exe" };
	}
	const actual = await sha256Of(exePath);
	if (actual !== expected) {
		try {
			unlinkSync(exePath);
		} catch {}
		return {
			ok: false,
			error: `checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
		};
	}

	return {
		ok: true,
		data: { stagedExe: exePath, version: cache.latestVersion },
	};
}

// Wait up to STAGING_ACK_TIMEOUT_MS for the staged child to write the ack
// marker. Bails early if the child process exits before acking — that's a
// startup crash and we want to surface it fast so the UI can recover.
async function waitForStagingAck(proc: {
	exited: Promise<number>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	const ack = stagingAckPath();
	const deadline = Date.now() + STAGING_ACK_TIMEOUT_MS;
	let exitedCode: number | null = null;
	void proc.exited.then((c) => {
		exitedCode = c;
	});
	while (Date.now() < deadline) {
		if (existsSync(ack)) return { ok: true };
		if (exitedCode !== null) {
			return {
				ok: false,
				reason: `staged exe exited with code ${exitedCode} before ack`,
			};
		}
		await new Promise((r) => setTimeout(r, STAGING_POLL_INTERVAL_MS));
	}
	return {
		ok: false,
		reason: `staged exe did not ack within ${STAGING_ACK_TIMEOUT_MS}ms`,
	};
}

export async function applyUpdate(
	stagedExe: string,
): Promise<ActionResult<{ version: string | null }>> {
	if (!existsSync(stagedExe)) {
		return { ok: false, error: "staged exe missing; re-download" };
	}

	// Clear any stale ack from a previous attempt before we launch.
	try {
		unlinkSync(stagingAckPath());
	} catch {}

	// `--background` is propagated all the way through:
	//   staged exe → maybeSelfInstall → spawn(canonical, [--background])
	// → canonical sees BACKGROUND_MODE=true and skips openInBrowser. Without
	// this the user gets a fresh browser tab popped at the end of every
	// update on top of the existing FORGE tab they're already in. The tab
	// they're in handles its own reload via /api/version polling.
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([stagedExe, "--background"], {
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
			windowsHide: true,
		});
	} catch (e) {
		return { ok: false, error: `failed to spawn: ${(e as Error).message}` };
	}

	const ack = await waitForStagingAck(proc);
	if (!ack.ok) {
		// Child crashed or hung before reaching the install handoff. Old
		// instance is still alive and nothing destructive happened — surface
		// the failure so the UI can offer "retry" without scaring the user.
		return { ok: false, error: ack.reason };
	}

	// Child has marked itself as committing to the install. Hand off via the
	// regular shutdown path so we share the existing 250ms-then-exit timer
	// (avoids racing with the shutdown POST the child also issues).
	const cache = await readCache().catch(() => null);
	shutdown();
	return { ok: true, data: { version: cache?.latestVersion ?? null } };
}

// Best-effort cleanup of the staging dir. Called on boot, after the new
// canonical instance is up, so a successful update doesn't leave the old
// versioned exe + checksums file lying around forever. Also wipes the
// staging-ack marker so the next update starts clean.
export function cleanupStagingDir(): void {
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
	try {
		const ack = stagingAckPath();
		if (existsSync(ack)) unlinkSync(ack);
	} catch {}
}
