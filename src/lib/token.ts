import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_DIR = join(homedir(), ".hlid");
const TOKEN_PATH = join(TOKEN_DIR, "token");

export function loadToken(): string {
	try {
		return readFileSync(TOKEN_PATH, "utf-8").trim();
	} catch {
		const token = randomBytes(32).toString("hex");
		try {
			mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
		} catch {}
		try {
			// Exclusive create. If another process wins the race, read what they wrote.
			writeFileSync(TOKEN_PATH, token, { mode: 0o600, flag: "wx" });
			return token;
		} catch {
			return readFileSync(TOKEN_PATH, "utf-8").trim();
		}
	}
}

export function verifyToken(
	candidate: string | null | undefined,
	expected: string,
): boolean {
	if (!candidate) return false;
	try {
		const a = Buffer.from(candidate, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}
