import {
	createCipheriv,
	createECDH,
	createHash,
	createHmac,
	createPrivateKey,
	randomBytes,
	sign,
	timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StoredPushSubscription } from "../db/pushNotifications";
import { APP_DIR } from "../lib/paths";
import type { BrowserPushSubscription } from "../lib/pushNotificationSchemas";
import {
	MAX_PUSH_NOTIFICATION_FUTURE_SKEW_MS,
	MAX_PUSH_NOTIFICATION_LIFETIME_MS,
	MAX_PUSH_NOTIFICATION_PAYLOAD_BYTES,
	PUSH_NOTIFICATION_TEST_URL,
	safePushNotificationUrl,
	type WebPushNotificationPayload,
	webPushNotificationPayloadSchema,
} from "../lib/pushNotificationSchemas";

export const VAPID_KEY_PATH = resolve(
	process.env.HLID_WEB_PUSH_PATH ?? APP_DIR,
	"web-push-vapid.json",
);

const VAPID_SUBJECT = "https://github.com/Kyle-Undefined/hlid";
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
const APPLE_VAPID_TOKEN_REUSE_MS = 60 * 60 * 1_000;
const VAPID_CACHE_RETENTION_MS = VAPID_TOKEN_LIFETIME_SECONDS * 1_000;
const WEB_PUSH_RECORD_SIZE = 4_096;
const MAX_WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_REQUEST_TIMEOUT_MS = 15_000;

export type VapidKeys = {
	publicKey: string;
	privateKey: string;
};

type VapidKeyFile = VapidKeys & {
	version: 1;
	createdAt: string;
};

export type PreparedWebPushRequest = {
	endpoint: string;
	headers: Headers;
	body: Uint8Array;
};

export type WebPushSendResult =
	| { outcome: "delivered"; statusCode: number }
	| { outcome: "gone"; statusCode: 404 | 410 }
	| { outcome: "failed"; statusCode: number | null };

type WebPushCryptoOptions = {
	nowMs?: number;
	salt?: Uint8Array;
	ephemeralPrivateKey?: Uint8Array;
};

const cachedVapidKeys = new Map<string, VapidKeys>();
const cachedAppleVapidAuthorizations = new Map<
	string,
	{ authorization: string; issuedAtMs: number }
>();

function decodeBase64Url(value: string, name: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error(`${name} must be unpadded base64url`);
	}
	return Buffer.from(value, "base64url");
}

function validatedVapidKeys(value: unknown): VapidKeys {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid Web Push VAPID key file");
	}
	const candidate = value as Partial<VapidKeyFile>;
	if (
		candidate.version !== 1 ||
		typeof candidate.publicKey !== "string" ||
		typeof candidate.privateKey !== "string"
	) {
		throw new Error("Invalid Web Push VAPID key file");
	}
	const publicKey = decodeBase64Url(candidate.publicKey, "VAPID public key");
	const privateKey = decodeBase64Url(candidate.privateKey, "VAPID private key");
	if (
		publicKey.length !== 65 ||
		publicKey[0] !== 4 ||
		privateKey.length !== 32
	) {
		throw new Error("Invalid Web Push VAPID key material");
	}
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(privateKey);
	const derived = ecdh.getPublicKey(undefined, "uncompressed");
	if (
		derived.length !== publicKey.length ||
		!timingSafeEqual(derived, publicKey)
	) {
		throw new Error("Web Push VAPID public and private keys do not match");
	}
	return {
		publicKey: candidate.publicKey,
		privateKey: candidate.privateKey,
	};
}

function generateVapidKeys(): VapidKeyFile {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		version: 1,
		publicKey: ecdh
			.getPublicKey(undefined, "uncompressed")
			.toString("base64url"),
		privateKey: ecdh.getPrivateKey().toString("base64url"),
		createdAt: new Date().toISOString(),
	};
}

/** Load or create the installation's durable VAPID identity. */
export function loadOrCreateVapidKeys(path = VAPID_KEY_PATH): VapidKeys {
	const cached = cachedVapidKeys.get(path);
	if (cached) return cached;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const generated = generateVapidKeys();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try {
			writeFileSync(path, `${JSON.stringify(generated)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			value = generated;
		} catch (writeError) {
			if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
				throw writeError;
			}
			value = JSON.parse(readFileSync(path, "utf8"));
		}
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows does not expose useful POSIX mode semantics.
	}
	const keys = validatedVapidKeys(value);
	cachedVapidKeys.set(path, keys);
	return keys;
}

function publicKeyCoordinates(publicKey: string): { x: string; y: string } {
	const decoded = decodeBase64Url(publicKey, "VAPID public key");
	if (decoded.length !== 65 || decoded[0] !== 4) {
		throw new Error("Invalid VAPID public key");
	}
	return {
		x: decoded.subarray(1, 33).toString("base64url"),
		y: decoded.subarray(33, 65).toString("base64url"),
	};
}

function vapidAuthorization(
	endpoint: URL,
	keys: VapidKeys,
	nowMs: number,
): string {
	const header = Buffer.from(
		JSON.stringify({ typ: "JWT", alg: "ES256" }),
	).toString("base64url");
	const claims = Buffer.from(
		JSON.stringify({
			aud: endpoint.origin,
			exp: Math.floor(nowMs / 1_000) + VAPID_TOKEN_LIFETIME_SECONDS,
			sub: VAPID_SUBJECT,
		}),
	).toString("base64url");
	const unsignedToken = `${header}.${claims}`;
	const { x, y } = publicKeyCoordinates(keys.publicKey);
	const privateKey = createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x,
			y,
			d: keys.privateKey,
		},
		format: "jwk",
	});
	const signature = sign("sha256", Buffer.from(unsignedToken), {
		key: privateKey,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	return `vapid t=${unsignedToken}.${signature}, k=${keys.publicKey}`;
}

function isApplePushService(endpoint: URL): boolean {
	const host = endpoint.hostname.toLowerCase();
	return host === "web.push.apple.com" || host.endsWith(".push.apple.com");
}

function appleVapidCacheKey(endpoint: URL, keys: VapidKeys): string {
	const keyFingerprint = createHash("sha256")
		.update(keys.publicKey)
		.update("\0")
		.update(keys.privateKey)
		.digest("base64url");
	return `${endpoint.origin}\0${keyFingerprint}`;
}

/**
 * Apple rejects excessive provider-token churn. Reuse the exact signed JWT for
 * at least one hour per push-service audience and VAPID identity while keeping
 * the general Web Push path stateless for other providers.
 */
function cachedVapidAuthorization(
	endpoint: URL,
	keys: VapidKeys,
	nowMs: number,
): string {
	if (!isApplePushService(endpoint)) {
		return vapidAuthorization(endpoint, keys, nowMs);
	}
	const cacheKey = appleVapidCacheKey(endpoint, keys);
	const cached = cachedAppleVapidAuthorizations.get(cacheKey);
	const ageMs = cached ? nowMs - cached.issuedAtMs : -1;
	if (cached && ageMs >= 0 && ageMs <= APPLE_VAPID_TOKEN_REUSE_MS) {
		return cached.authorization;
	}
	for (const [key, entry] of cachedAppleVapidAuthorizations) {
		if (
			nowMs < entry.issuedAtMs ||
			nowMs - entry.issuedAtMs > VAPID_CACHE_RETENTION_MS
		) {
			cachedAppleVapidAuthorizations.delete(key);
		}
	}
	const authorization = vapidAuthorization(endpoint, keys, nowMs);
	cachedAppleVapidAuthorizations.set(cacheKey, {
		authorization,
		issuedAtMs: nowMs,
	});
	return authorization;
}

function pushTopic(payload: WebPushNotificationPayload): string {
	const topic =
		payload.kind === "test"
			? "hlid-test"
			: payload.sessionIds
				? `hlid-work-finished-batch:${payload.batchId}`
				: payload.sessionId;
	return createHash("sha256").update(topic).digest("base64url").slice(0, 32);
}

function pushServiceUrl(endpoint: string): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("Invalid Web Push endpoint");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		(url.port && url.port !== "443")
	) {
		throw new Error("Web Push endpoint must be a standard HTTPS push service");
	}
	const host = url.hostname.toLowerCase();
	const allowed =
		host === "fcm.googleapis.com" ||
		host === "web.push.apple.com" ||
		host.endsWith(".push.apple.com") ||
		host === "updates.push.services.mozilla.com" ||
		host.endsWith(".push.services.mozilla.com") ||
		host.endsWith(".notify.windows.com");
	if (!allowed) {
		throw new Error("Unrecognized Web Push service endpoint");
	}
	return url;
}

/** Validate an endpoint before it becomes a durable outbound request target. */
export function validatePushServiceEndpoint(endpoint: string): void {
	pushServiceUrl(endpoint);
}

export function validateBrowserPushSubscription(
	subscription: BrowserPushSubscription,
): void {
	validatePushServiceEndpoint(subscription.endpoint);
	const publicKey = decodeBase64Url(
		subscription.keys.p256dh,
		"Web Push p256dh key",
	);
	const authSecret = decodeBase64Url(
		subscription.keys.auth,
		"Web Push auth secret",
	);
	if (publicKey.length !== 65 || publicKey[0] !== 4) {
		throw new Error("Invalid Web Push p256dh key");
	}
	if (authSecret.length !== 16) {
		throw new Error("Invalid Web Push auth secret");
	}
	try {
		const probe = createECDH("prime256v1");
		probe.generateKeys();
		probe.computeSecret(publicKey);
	} catch {
		throw new Error("Invalid Web Push p256dh key");
	}
}

function hmacSha256(key: Uint8Array, value: Uint8Array): Buffer {
	return createHmac("sha256", key).update(value).digest();
}

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Buffer {
	return hmacSha256(salt, ikm);
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
	let previous: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const chunks: Buffer<ArrayBufferLike>[] = [];
	for (let counter = 1; Buffer.concat(chunks).length < length; counter += 1) {
		if (counter > 255) throw new Error("HKDF output is too large");
		previous = hmacSha256(
			prk,
			Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]),
		);
		chunks.push(previous);
	}
	return Buffer.concat(chunks).subarray(0, length);
}

function webPushInfo(
	clientPublicKey: Uint8Array,
	serverPublicKey: Uint8Array,
): Buffer {
	return Buffer.concat([
		Buffer.from("WebPush: info\0", "utf8"),
		clientPublicKey,
		serverPublicKey,
	]);
}

function serializePayload(
	payload: WebPushNotificationPayload,
	nowMs: number,
): Buffer {
	const parsed = webPushNotificationPayloadSchema.parse(payload);
	if (
		parsed.createdAt > nowMs + MAX_PUSH_NOTIFICATION_FUTURE_SKEW_MS ||
		parsed.createdAt < nowMs - MAX_PUSH_NOTIFICATION_LIFETIME_MS ||
		parsed.expiresAt <= nowMs
	) {
		throw new Error("Web Push notification payload is stale or future-dated");
	}
	const navigate =
		parsed.kind === "test"
			? PUSH_NOTIFICATION_TEST_URL
			: parsed.sessionIds
				? "/raven"
				: safePushNotificationUrl(parsed.sessionId, parsed.url);
	const tag =
		parsed.kind === "test"
			? "hlid-test"
			: parsed.sessionIds
				? `hlid-work-finished-batch:${parsed.batchId}`
				: `hlid-session:${parsed.sessionId}`;
	const serialized = Buffer.from(
		JSON.stringify({
			web_push: 8030,
			notification: {
				title: parsed.title,
				body: parsed.body,
				mutable: true,
				navigate,
				tag,
				timestamp: parsed.createdAt,
				data: {
					version: parsed.version,
					kind: parsed.kind,
					...(parsed.kind === "test"
						? {}
						: {
								sessionId: parsed.sessionId,
								...(parsed.sessionIds ? { sessionIds: parsed.sessionIds } : {}),
								...(parsed.batchId ? { batchId: parsed.batchId } : {}),
								...(parsed.reason ? { reason: parsed.reason } : {}),
								...(parsed.sessionLabel
									? { sessionLabel: parsed.sessionLabel }
									: {}),
								...(parsed.durationMs !== undefined
									? { durationMs: parsed.durationMs }
									: {}),
							}),
					url: navigate,
					createdAt: parsed.createdAt,
					expiresAt: parsed.expiresAt,
				},
			},
		}),
	);
	if (serialized.byteLength > MAX_PUSH_NOTIFICATION_PAYLOAD_BYTES) {
		throw new Error("Web Push notification payload is too large");
	}
	return serialized;
}

function encryptPayload(
	clientPublicKey: Buffer,
	authSecret: Buffer,
	payload: Buffer,
	options: WebPushCryptoOptions,
): Uint8Array {
	if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 4) {
		throw new Error("Invalid Web Push p256dh key");
	}
	if (authSecret.length !== 16) {
		throw new Error("Invalid Web Push auth secret");
	}
	const salt = Buffer.from(options.salt ?? randomBytes(16));
	if (salt.length !== 16) throw new Error("Web Push salt must be 16 bytes");
	const server = createECDH("prime256v1");
	if (options.ephemeralPrivateKey) {
		server.setPrivateKey(options.ephemeralPrivateKey);
	} else {
		server.generateKeys();
	}
	const serverPublicKey = server.getPublicKey(undefined, "uncompressed");
	let sharedSecret: Buffer;
	try {
		sharedSecret = server.computeSecret(clientPublicKey);
	} catch {
		throw new Error("Invalid Web Push p256dh key");
	}
	const inputKeyMaterial = hkdfExpand(
		hkdfExtract(authSecret, sharedSecret),
		webPushInfo(clientPublicKey, serverPublicKey),
		32,
	);
	const contentPrk = hkdfExtract(salt, inputKeyMaterial);
	const contentEncryptionKey = hkdfExpand(
		contentPrk,
		Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
		16,
	);
	const nonce = hkdfExpand(
		contentPrk,
		Buffer.from("Content-Encoding: nonce\0", "utf8"),
		12,
	);
	const recordPlaintext = Buffer.concat([payload, Buffer.from([2])]);
	const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
	const encrypted = Buffer.concat([
		cipher.update(recordPlaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const recordSize = Math.max(WEB_PUSH_RECORD_SIZE, encrypted.byteLength);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(recordSize, 16);
	header[20] = serverPublicKey.byteLength;
	return Buffer.concat([header, serverPublicKey, encrypted]);
}

export function prepareWebPushRequest(
	subscription: Pick<StoredPushSubscription, "endpoint" | "keys">,
	payload: WebPushNotificationPayload,
	vapidKeys: VapidKeys,
	options: WebPushCryptoOptions & { ttlSeconds?: number } = {},
): PreparedWebPushRequest {
	const nowMs = options.nowMs ?? Date.now();
	const endpoint = pushServiceUrl(subscription.endpoint);
	const ttlSeconds = Math.min(
		Math.max(
			0,
			options.ttlSeconds ?? Math.ceil((payload.expiresAt - nowMs) / 1_000),
		),
		MAX_WEB_PUSH_TTL_SECONDS,
	);
	const serialized = serializePayload(payload, nowMs);
	const body = encryptPayload(
		decodeBase64Url(subscription.keys.p256dh, "Web Push p256dh key"),
		decodeBase64Url(subscription.keys.auth, "Web Push auth secret"),
		serialized,
		options,
	);
	return {
		endpoint: endpoint.href,
		headers: new Headers({
			authorization: cachedVapidAuthorization(endpoint, vapidKeys, nowMs),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(ttlSeconds),
			topic: pushTopic(payload),
			urgency: payload.kind === "needs_attention" ? "high" : "normal",
		}),
		body,
	};
}

export async function sendWebPush(
	subscription: Pick<StoredPushSubscription, "endpoint" | "keys">,
	payload: WebPushNotificationPayload,
	options: {
		vapidKeys?: VapidKeys;
		fetch?: typeof fetch;
		nowMs?: number;
		ttlSeconds?: number;
		signal?: AbortSignal;
	} = {},
): Promise<WebPushSendResult> {
	let request: PreparedWebPushRequest;
	try {
		request = prepareWebPushRequest(
			subscription,
			payload,
			options.vapidKeys ?? loadOrCreateVapidKeys(),
			{ nowMs: options.nowMs, ttlSeconds: options.ttlSeconds },
		);
	} catch {
		return { outcome: "failed", statusCode: null };
	}
	try {
		const requestBody = new Uint8Array(request.body.byteLength);
		requestBody.set(request.body);
		const response = await (options.fetch ?? fetch)(request.endpoint, {
			method: "POST",
			headers: request.headers,
			body: requestBody.buffer,
			redirect: "manual",
			signal: options.signal ?? AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
		});
		if (response.status === 404 || response.status === 410) {
			return { outcome: "gone", statusCode: response.status };
		}
		return response.ok
			? { outcome: "delivered", statusCode: response.status }
			: { outcome: "failed", statusCode: response.status };
	} catch {
		return { outcome: "failed", statusCode: null };
	}
}
