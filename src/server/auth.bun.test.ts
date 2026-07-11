import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDbForTest } from "../db/schema";

const directory = mkdtempSync(join(tmpdir(), "hlid-auth-"));
process.env.HLID_AUTH_PATH = directory;
const auth = await import("./auth");
const db = new Database(":memory:");

beforeAll(() => setDbForTest(db));
afterAll(() => {
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("server-side authentication lifecycle", () => {
	test("hashes credentials, stores opaque sessions, revokes, changes, and resets", async () => {
		expect(auth.hasCredential()).toBe(false);
		await expect(auth.createInitialPassword("short")).rejects.toThrow("12-256");

		await auth.createInitialPassword("correct horse battery staple");
		const credentialText = readFileSync(auth.AUTH_PATH, "utf8");
		expect(credentialText).not.toContain("correct horse battery staple");
		expect(credentialText).toContain("$argon2id$");
		await expect(
			auth.createInitialPassword("another password value"),
		).rejects.toThrow("already configured");

		expect(await auth.verifyLogin("wrong password", "127.0.0.1")).toBe(false);
		expect(
			await auth.verifyLogin("correct horse battery staple", "127.0.0.1"),
		).toBe(true);

		const token = await auth.createSession("bun test");
		expect(await auth.validateSessionToken(token)).toBe(true);
		const stored = db
			.query<{ token_hash: string }, []>("SELECT token_hash FROM auth_sessions")
			.get();
		expect(stored?.token_hash).not.toBe(token);
		await auth.revokeSession(token);
		expect(await auth.validateSessionToken(token)).toBe(false);

		const second = await auth.createSession();
		expect(
			await auth.changePassword(
				"correct horse battery staple",
				"new correct horse battery staple",
			),
		).toBe(true);
		expect(await auth.validateSessionToken(second)).toBe(false);
		expect(
			await auth.verifyLogin("new correct horse battery staple", "127.0.0.1"),
		).toBe(true);

		await auth.resetAuthentication();
		expect(auth.hasCredential()).toBe(false);
	});

	test("orphaned sessions cannot authenticate or survive replacement setup", async () => {
		await auth.createInitialPassword("first password lifecycle");
		const orphanedToken = await auth.createSession("orphaned browser");
		expect(await auth.validateSessionToken(orphanedToken)).toBe(true);

		// Simulate a manual auth.json deletion without the supported reset command.
		rmSync(auth.AUTH_PATH, { force: true });
		expect(auth.hasCredential()).toBe(false);
		expect(await auth.validateSessionToken(orphanedToken)).toBe(false);
		expect(
			await auth.authenticateRequest(
				new Request("http://localhost", {
					headers: { cookie: `${auth.AUTH_COOKIE}=${orphanedToken}` },
				}),
			),
		).toBe(false);

		await auth.createInitialPassword("replacement password lifecycle");
		expect(await auth.validateSessionToken(orphanedToken)).toBe(false);
		await auth.resetAuthentication();
	});
});
