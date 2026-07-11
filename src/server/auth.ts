import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb } from "../db";
import { APP_DIR } from "../lib/paths";
import { verifyToken } from "../lib/token";

export const AUTH_COOKIE = "hlid_session";
export const AUTH_PATH = resolve(
	process.env.HLID_AUTH_PATH ?? APP_DIR,
	"auth.json",
);
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

type CredentialFile = { version: 1; passwordHash: string };
export type AuthState = "setup-required" | "locked" | "authenticated";

const attemptsByIp = new Map<string, number[]>();
let globalAttempts: number[] = [];
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const GLOBAL_MAX_ATTEMPTS = 50;

function credential(): CredentialFile | null {
	try {
		const value = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as CredentialFile;
		if (value.version !== 1 || typeof value.passwordHash !== "string") {
			throw new Error("Invalid authentication credential file");
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function writeCredential(value: CredentialFile, firstSetup: boolean): void {
	mkdirSync(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
	if (firstSetup) {
		writeFileSync(AUTH_PATH, JSON.stringify(value), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		return;
	}
	const temporary = `${AUTH_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value), {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporary, AUTH_PATH);
		try {
			chmodSync(AUTH_PATH, 0o600);
		} catch {}
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function validatePassword(password: string): void {
	if (
		typeof password !== "string" ||
		password.length < MIN_PASSWORD_LENGTH ||
		password.length > MAX_PASSWORD_LENGTH
	) {
		throw new Error(
			`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
		);
	}
}

async function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, {
		algorithm: "argon2id",
		memoryCost: 65_536,
		timeCost: 3,
	});
}

async function passwordMatches(
	password: string,
	hash: string,
): Promise<boolean> {
	try {
		return await Bun.password.verify(password, hash, "argon2id");
	} catch {
		return false;
	}
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function readCookie(
	request: Request,
	name = AUTH_COOKIE,
): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(/;\s*/)) {
		const equals = part.indexOf("=");
		if (equals < 0 || part.slice(0, equals) !== name) continue;
		try {
			return decodeURIComponent(part.slice(equals + 1));
		} catch {
			return null;
		}
	}
	return null;
}

export function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const normalized = address.toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "::ffff:127.0.0.1"
	);
}

export function isSecureRequest(request: Request, peerIp?: string): boolean {
	if (new URL(request.url).protocol === "https:") return true;
	return (
		isLoopback(peerIp) &&
		request.headers.get("x-hlid-forwarded-proto")?.toLowerCase() === "https"
	);
}

/** Resolve the original client address only when a loopback TLS proxy proves
 * it is this Hlid installation. Browser-supplied forwarding headers are ignored. */
export function effectivePeerIp(
	request: Request,
	directPeerIp: string | undefined,
	internalToken: string,
): string | undefined {
	if (
		!isLoopback(directPeerIp) ||
		!verifyToken(request.headers.get("x-hlid-proxy-token"), internalToken)
	) {
		return directPeerIp;
	}
	const forwarded = request.headers.get("x-hlid-forwarded-client-ip")?.trim();
	if (!forwarded || forwarded.length > 64 || /[\r\n,]/.test(forwarded)) {
		return directPeerIp;
	}
	return forwarded;
}

export function sessionCookie(token: string, secure: boolean): string {
	return [
		`${AUTH_COOKIE}=${encodeURIComponent(token)}`,
		"HttpOnly",
		"SameSite=Strict",
		"Path=/",
		`Max-Age=${SESSION_MAX_AGE_SECONDS}`,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
	return [
		`${AUTH_COOKIE}=`,
		"HttpOnly",
		"SameSite=Strict",
		"Path=/",
		"Max-Age=0",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function hasCredential(): boolean {
	return credential() !== null;
}

export async function createInitialPassword(password: string): Promise<void> {
	validatePassword(password);
	if (hasCredential()) throw new Error("Authentication is already configured");
	const passwordHash = await hashPassword(password);
	try {
		writeCredential({ version: 1, passwordHash }, true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Authentication is already configured");
		}
		throw error;
	}
	// A manually removed credential can leave trusted-device rows behind. They
	// belong to the previous password lifecycle and must never become valid again
	// when a replacement credential is created.
	await revokeAllSessions();
}

export async function createSession(deviceLabel?: string): Promise<string> {
	const token = randomBytes(32).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const db = await getDb();
	db.run(`DELETE FROM auth_sessions WHERE expires_at <= ?`, [now]);
	db.run(
		`INSERT INTO auth_sessions(token_hash, created_at, expires_at, last_used_at, device_label)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			tokenHash(token),
			now,
			now + SESSION_MAX_AGE_SECONDS,
			now,
			deviceLabel?.slice(0, 200) ?? null,
		],
	);
	return token;
}

export async function validateSessionToken(
	token: string | null | undefined,
): Promise<boolean> {
	// A session is meaningful only while the credential that issued it exists.
	// This also prevents /login <-> / redirect loops after auth.json is removed.
	if (!hasCredential()) return false;
	if (!token || token.length > 256) return false;
	const now = Math.floor(Date.now() / 1000);
	const hash = tokenHash(token);
	const db = await getDb();
	const row = db
		.query<{ token_hash: string; last_used_at: number }, [string, number]>(
			`SELECT token_hash, last_used_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?`,
		)
		.get(hash, now);
	if (!row) return false;
	const expected = Buffer.from(row.token_hash, "hex");
	const candidate = Buffer.from(hash, "hex");
	if (
		expected.length !== candidate.length ||
		!timingSafeEqual(expected, candidate)
	) {
		return false;
	}
	if (now - row.last_used_at >= 300) {
		db.run(`UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?`, [
			now,
			hash,
		]);
	}
	return true;
}

export async function authenticateRequest(request: Request): Promise<boolean> {
	return validateSessionToken(readCookie(request));
}

export async function authState(request: Request): Promise<AuthState> {
	if (!hasCredential()) return "setup-required";
	return (await authenticateRequest(request)) ? "authenticated" : "locked";
}

function pruneAttempts(values: number[], now: number): number[] {
	return values.filter((timestamp) => now - timestamp < ATTEMPT_WINDOW_MS);
}

export function loginRetryAfterSeconds(peerIp: string): number {
	const now = Date.now();
	const key = peerIp || "unknown";
	const local = pruneAttempts(attemptsByIp.get(key) ?? [], now);
	globalAttempts = pruneAttempts(globalAttempts, now);
	if (local.length > 0) attemptsByIp.set(key, local);
	else attemptsByIp.delete(key);
	const oldest = local[0] ?? globalAttempts[0];
	if (
		local.length < MAX_ATTEMPTS &&
		globalAttempts.length < GLOBAL_MAX_ATTEMPTS
	) {
		return 0;
	}
	return Math.max(1, Math.ceil((ATTEMPT_WINDOW_MS - (now - oldest)) / 1000));
}

function recordFailure(peerIp: string): void {
	const now = Date.now();
	const key = peerIp || "unknown";
	const local = pruneAttempts(attemptsByIp.get(key) ?? [], now);
	local.push(now);
	attemptsByIp.set(key, local);
	globalAttempts = pruneAttempts(globalAttempts, now);
	globalAttempts.push(now);
}

export async function verifyLogin(
	password: string,
	peerIp: string,
): Promise<boolean> {
	const current = credential();
	if (!current) return false;
	const matches = await passwordMatches(password, current.passwordHash);
	if (!matches) {
		recordFailure(peerIp);
		return false;
	}
	attemptsByIp.delete(peerIp || "unknown");
	return true;
}

export async function revokeSession(
	token: string | null | undefined,
): Promise<void> {
	if (!token) return;
	const db = await getDb();
	db.run(`DELETE FROM auth_sessions WHERE token_hash = ?`, [tokenHash(token)]);
}

export async function revokeAllSessions(): Promise<void> {
	const db = await getDb();
	db.run(`DELETE FROM auth_sessions`);
}

export async function changePassword(
	currentPassword: string,
	newPassword: string,
	peerIp = "",
): Promise<boolean> {
	validatePassword(newPassword);
	const current = credential();
	if (
		!current ||
		!(await passwordMatches(currentPassword, current.passwordHash))
	) {
		recordFailure(peerIp);
		return false;
	}
	attemptsByIp.delete(peerIp || "unknown");
	writeCredential(
		{ version: 1, passwordHash: await hashPassword(newPassword) },
		false,
	);
	await revokeAllSessions();
	return true;
}

export async function resetAuthentication(): Promise<void> {
	rmSync(AUTH_PATH, { force: true });
	await revokeAllSessions();
}

export async function authorizeServiceRequest(
	request: Request,
	peerIp: string | undefined,
	internalToken: string,
): Promise<boolean> {
	if (
		isLoopback(peerIp) &&
		verifyToken(request.headers.get("x-hlid-internal"), internalToken)
	) {
		return true;
	}
	return authenticateRequest(request);
}
