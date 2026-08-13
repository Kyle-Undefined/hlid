import {
	createDecipheriv,
	createECDH,
	createPublicKey,
	hkdfSync,
	verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StoredPushSubscription } from "../db";
import type { WebPushNotificationPayload } from "../lib/pushNotificationSchemas";
import {
	loadOrCreateVapidKeys,
	prepareWebPushRequest,
	sendWebPush,
	validateBrowserPushSubscription,
} from "./webPush";

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

function keyPair(privateByte: number) {
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(Buffer.alloc(32, privateByte));
	return {
		ecdh,
		publicKey: ecdh.getPublicKey(undefined, "uncompressed"),
		privateKey: ecdh.getPrivateKey(),
	};
}

function vapidKeys(privateByte = 3) {
	const pair = keyPair(privateByte);
	return {
		publicKey: pair.publicKey.toString("base64url"),
		privateKey: pair.privateKey.toString("base64url"),
	};
}

function fixture() {
	const client = keyPair(5);
	const auth = Buffer.alloc(16, 9);
	const subscription: StoredPushSubscription = {
		id: "device-1",
		authSessionHash: "auth-session-1",
		endpoint: "https://fcm.googleapis.com/wp/device-1",
		keys: {
			p256dh: client.publicKey.toString("base64url"),
			auth: auth.toString("base64url"),
		},
		expirationTime: null,
		preferences: {
			needs_attention: true,
			work_finished: false,
			privacy: "generic",
		},
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
		lastSuccessAt: null,
		lastFailureAt: null,
		failureCount: 0,
	};
	const payload: WebPushNotificationPayload = {
		version: 1,
		kind: "needs_attention",
		sessionId: "session-1",
		title: "Hlid needs your attention",
		body: "Open Hlid to continue.",
		url: "/raven?session=session-1",
		createdAt: NOW,
		expiresAt: NOW + 30 * 60_000,
	};
	return { auth, client, payload, subscription };
}

function decryptBody(
	body: Uint8Array,
	client: ReturnType<typeof keyPair>["ecdh"],
	auth: Buffer,
): Buffer {
	const encoded = Buffer.from(body);
	const salt = encoded.subarray(0, 16);
	const recordSize = encoded.readUInt32BE(16);
	const keyLength = encoded[20];
	const serverPublicKey = encoded.subarray(21, 21 + keyLength);
	const ciphertext = encoded.subarray(21 + keyLength);
	expect(keyLength).toBe(65);
	expect(recordSize).toBeGreaterThanOrEqual(ciphertext.byteLength);

	const sharedSecret = client.computeSecret(serverPublicKey);
	const info = Buffer.concat([
		Buffer.from("WebPush: info\0"),
		client.getPublicKey(undefined, "uncompressed"),
		serverPublicKey,
	]);
	const inputKeyMaterial = Buffer.from(
		hkdfSync("sha256", sharedSecret, auth, info, 32),
	);
	const contentEncryptionKey = Buffer.from(
		hkdfSync(
			"sha256",
			inputKeyMaterial,
			salt,
			Buffer.from("Content-Encoding: aes128gcm\0"),
			16,
		),
	);
	const nonce = Buffer.from(
		hkdfSync(
			"sha256",
			inputKeyMaterial,
			salt,
			Buffer.from("Content-Encoding: nonce\0"),
			12,
		),
	);
	const decipher = createDecipheriv("aes-128-gcm", contentEncryptionKey, nonce);
	decipher.setAuthTag(ciphertext.subarray(-16));
	return Buffer.concat([
		decipher.update(ciphertext.subarray(0, -16)),
		decipher.final(),
	]);
}

describe("standards-only Web Push sender", () => {
	it("creates one durable private VAPID identity with a public application key", () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-vapid-"));
		const path = join(root, "nested", "web-push-vapid.json");
		const first = loadOrCreateVapidKeys(path);
		const second = loadOrCreateVapidKeys(path);
		expect(second).toEqual(first);
		expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
		expect(Buffer.from(first.privateKey, "base64url")).toHaveLength(32);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			version: 1,
			publicKey: first.publicKey,
			privateKey: first.privateKey,
		});
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("encrypts an RFC 8291 aes128gcm record and signs valid VAPID headers", () => {
		const { auth, client, payload, subscription } = fixture();
		const prepared = prepareWebPushRequest(subscription, payload, vapidKeys(), {
			nowMs: NOW,
			salt: Buffer.alloc(16, 7),
			ephemeralPrivateKey: Buffer.alloc(32, 11),
		});
		expect(prepared.endpoint).toBe(subscription.endpoint);
		expect(prepared.headers.get("content-encoding")).toBe("aes128gcm");
		expect(prepared.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(prepared.headers.get("ttl")).toBe("1800");
		expect(prepared.headers.get("urgency")).toBe("high");
		const topic = prepared.headers.get("topic") ?? "";
		expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(
			prepareWebPushRequest(subscription, payload, vapidKeys(), {
				nowMs: NOW,
			}).headers.get("topic"),
		).toBe(topic);
		expect(
			prepareWebPushRequest(
				subscription,
				{ ...payload, kind: "work_finished" },
				vapidKeys(),
				{ nowMs: NOW },
			).headers.get("topic"),
		).toBe(topic);
		expect(
			prepareWebPushRequest(
				subscription,
				{
					...payload,
					sessionId: "session-2",
					url: "/raven?session=session-2",
				},
				vapidKeys(),
				{ nowMs: NOW },
			).headers.get("topic"),
		).not.toBe(topic);

		const decrypted = decryptBody(prepared.body, client.ecdh, auth);
		expect(decrypted.at(-1)).toBe(2);
		expect(JSON.parse(decrypted.subarray(0, -1).toString("utf8"))).toEqual({
			web_push: 8030,
			notification: {
				title: payload.title,
				body: payload.body,
				mutable: true,
				navigate: "/raven?session=session-1",
				tag: "hlid-session:session-1",
				timestamp: payload.createdAt,
				data: {
					version: 1,
					kind: "needs_attention",
					sessionId: "session-1",
					url: "/raven?session=session-1",
					createdAt: payload.createdAt,
					expiresAt: payload.expiresAt,
				},
			},
		});

		const authorization = prepared.headers.get("authorization") ?? "";
		const match = authorization.match(/^vapid t=([^,]+), k=(.+)$/);
		expect(match).not.toBeNull();
		const [header, claims, signature] = match?.[1].split(".") ?? [];
		expect(
			JSON.parse(Buffer.from(claims, "base64url").toString()),
		).toMatchObject({
			aud: "https://fcm.googleapis.com",
			sub: "https://github.com/Kyle-Undefined/hlid",
		});
		const rawPublic = Buffer.from(match?.[2] ?? "", "base64url");
		const publicKey = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: rawPublic.subarray(1, 33).toString("base64url"),
				y: rawPublic.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${claims}`),
				{
					key: publicKey,
					dsaEncoding: "ieee-p1363",
				},
				Buffer.from(signature, "base64url"),
			),
		).toBe(true);
	});

	it("reuses Apple VAPID JWTs for one hour per audience and signing key", () => {
		const { payload, subscription } = fixture();
		const applePayload = { ...payload, expiresAt: NOW + 4 * 60 * 60_000 };
		const appleSubscription = {
			...subscription,
			endpoint: "https://web.push.apple.com/Q-device-one",
		};
		const authorization = (nowMs: number, keys = vapidKeys()) =>
			prepareWebPushRequest(appleSubscription, applePayload, keys, {
				nowMs,
			}).headers.get("authorization");

		const first = authorization(NOW);
		expect(authorization(NOW + 60 * 60_000)).toBe(first);
		expect(authorization(NOW + 60 * 60_000 + 1)).not.toBe(first);
		expect(authorization(NOW + 1, vapidKeys(4))).not.toBe(first);
		const otherAudience = prepareWebPushRequest(
			{
				...appleSubscription,
				endpoint: "https://api.push.apple.com/Q-device-two",
			},
			applePayload,
			vapidKeys(),
			{ nowMs: NOW + 1 },
		).headers.get("authorization");
		expect(otherAudience).not.toBe(first);
	});

	it("restricts durable endpoints and validates browser key material", () => {
		const { subscription } = fixture();
		expect(() =>
			validateBrowserPushSubscription({
				endpoint: subscription.endpoint,
				expirationTime: null,
				keys: subscription.keys,
			}),
		).not.toThrow();
		expect(() =>
			validateBrowserPushSubscription({
				endpoint: "https://127.0.0.1/internal",
				keys: subscription.keys,
			}),
		).toThrow("Unrecognized Web Push service endpoint");
		expect(() =>
			prepareWebPushRequest(
				{ ...subscription, endpoint: "https://example.com/push" },
				fixture().payload,
				vapidKeys(),
				{ nowMs: NOW },
			),
		).toThrow("Unrecognized Web Push service endpoint");
	});

	it("rejects stale notification payloads before an outbound request", () => {
		const { payload, subscription } = fixture();
		expect(() =>
			prepareWebPushRequest(
				subscription,
				{ ...payload, expiresAt: NOW - 1 },
				vapidKeys(),
				{ nowMs: NOW },
			),
		).toThrow();
	});

	it("uses non-following POST requests and maps success and gone endpoints", async () => {
		const { payload, subscription } = fixture();
		const deliveredFetch = vi.fn(
			async () => new Response(null, { status: 201 }),
		);
		expect(
			await sendWebPush(subscription, payload, {
				fetch: deliveredFetch as unknown as typeof fetch,
				vapidKeys: vapidKeys(),
				nowMs: NOW,
			}),
		).toEqual({ outcome: "delivered", statusCode: 201 });
		expect(deliveredFetch).toHaveBeenCalledWith(
			subscription.endpoint,
			expect.objectContaining({ method: "POST", redirect: "manual" }),
		);

		const goneFetch = vi.fn(async () => new Response(null, { status: 410 }));
		expect(
			await sendWebPush(subscription, payload, {
				fetch: goneFetch as unknown as typeof fetch,
				vapidKeys: vapidKeys(),
				nowMs: NOW,
			}),
		).toEqual({ outcome: "gone", statusCode: 410 });
	});
});
