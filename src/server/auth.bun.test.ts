import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPushSubscription,
	upsertPushSubscription,
} from "../db/pushNotifications";
import { setDbForTest } from "../db/schema";
import {
	PROJECT_PREVIEW_AUTH_ENV,
	PROJECT_PREVIEW_AUTH_HEADER,
} from "./projectPreviewTrust";

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
	test("accepts the private child capability without granting session administration", async () => {
		process.env[PROJECT_PREVIEW_AUTH_ENV] = "preview-auth-test-token";
		try {
			const trusted = new Request("http://127.0.0.1:5173", {
				headers: {
					[PROJECT_PREVIEW_AUTH_HEADER]: "preview-auth-test-token",
				},
			});
			const wrong = new Request("http://127.0.0.1:5173", {
				headers: { [PROJECT_PREVIEW_AUTH_HEADER]: "wrong" },
			});

			expect(auth.hasCredential()).toBe(false);
			expect(await auth.authenticateRequest(trusted)).toBe(true);
			expect(await auth.authState(trusted)).toBe("authenticated");
			expect(await auth.authenticateSessionRequest(trusted)).toBe(false);
			expect(await auth.authenticatedSessionHash(trusted)).toBeNull();
			expect(
				await auth.authorizeServiceRequest(
					trusted,
					"192.0.2.5",
					"internal-secret",
				),
			).toBe(true);
			expect(await auth.authenticateRequest(wrong)).toBe(false);
			expect(await auth.authState(wrong)).toBe("setup-required");
		} finally {
			delete process.env[PROJECT_PREVIEW_AUTH_ENV];
		}
	});

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
		const tokenRequest = new Request("http://localhost", {
			headers: { cookie: `${auth.AUTH_COOKIE}=${encodeURIComponent(token)}` },
		});
		const sessionHash = await auth.authenticatedSessionHash(tokenRequest);
		expect(sessionHash).toMatch(/^[a-f0-9]{64}$/);
		const stored = db
			.query<{ token_hash: string }, []>("SELECT token_hash FROM auth_sessions")
			.get();
		expect(stored?.token_hash).not.toBe(token);
		await upsertPushSubscription(
			{
				endpoint: "https://fcm.googleapis.com/fcm/send/auth-device-one",
				expirationTime: null,
				keys: { p256dh: "public", auth: "auth" },
			},
			sessionHash ?? "",
		);
		await auth.revokeSession(token);
		expect(await auth.validateSessionToken(token)).toBe(false);
		expect(
			await getPushSubscription(
				"https://fcm.googleapis.com/fcm/send/auth-device-one",
			),
		).toBeNull();

		const second = await auth.createSession();
		const secondHash = await auth.authenticatedSessionHash(
			new Request("http://localhost", {
				headers: { cookie: `${auth.AUTH_COOKIE}=${second}` },
			}),
		);
		await upsertPushSubscription(
			{
				endpoint: "https://fcm.googleapis.com/fcm/send/auth-device-two",
				keys: { p256dh: "public", auth: "auth" },
			},
			secondHash ?? "",
		);
		// A nullable v1 row has no individual owner, but global credential
		// revocation must still remove it.
		db.run(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth)
			 VALUES ('legacy-auth-device', 'https://fcm.googleapis.com/fcm/send/legacy-auth-device', 'public', 'auth')`,
		);
		expect(
			await auth.changePassword(
				"correct horse battery staple",
				"new correct horse battery staple",
			),
		).toBe(true);
		expect(await auth.validateSessionToken(second)).toBe(false);
		expect(
			db
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM push_subscriptions`,
				)
				.get()?.count,
		).toBe(0);
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
