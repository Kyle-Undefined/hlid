import * as z from "zod";

export const MAX_PUSH_ENDPOINT_CHARS = 4_096;
export const MAX_PUSH_SESSION_ID_CHARS = 256;
export const MAX_PUSH_NOTIFICATION_PAYLOAD_BYTES = 8 * 1_024;
export const MAX_PUSH_NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_PUSH_NOTIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const base64UrlSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9_-]+$/, "must be unpadded base64url");

export const pushPreferencesSchema = z
	.object({
		needs_attention: z.boolean(),
		work_finished: z.boolean(),
		privacy: z.enum(["generic", "detailed"]),
	})
	.strict();

export const pushPreferencesPatchSchema = pushPreferencesSchema
	.partial()
	.refine((value) => Object.keys(value).length > 0, {
		message: "at least one preference is required",
	});

export const browserPushSubscriptionSchema = z
	.object({
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS),
		expirationTime: z.number().int().positive().safe().nullable().optional(),
		keys: z
			.object({
				p256dh: base64UrlSchema,
				auth: base64UrlSchema,
			})
			.strict(),
	})
	.strict();

export const subscribePushSchema = z
	.object({
		subscription: browserPushSubscriptionSchema,
		preferences: pushPreferencesSchema.optional(),
	})
	.strict();

export const pushEndpointSchema = z
	.object({ endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS) })
	.strict();

export const pushStatusSchema = z
	.object({
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS).optional(),
	})
	.strict();

export const updatePushSubscriptionSchema = z
	.object({
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS),
		preferences: pushPreferencesPatchSchema,
	})
	.strict();

export const sessionNotificationModeSchema = z.enum([
	"default",
	"notify",
	"mute",
]);

export const pushSessionIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_PUSH_SESSION_ID_CHARS);

export const updatePushSessionOverrideSchema = z
	.object({
		session_id: pushSessionIdSchema,
		mode: sessionNotificationModeSchema,
	})
	.strict();

export const webPushNotificationPayloadSchema = z
	.object({
		version: z.literal(1),
		kind: z.enum(["needs_attention", "work_finished"]),
		sessionId: pushSessionIdSchema,
		title: z.string().min(1).max(160),
		body: z.string().min(1).max(500),
		url: z.string().min(1).max(2_048).optional(),
		createdAt: z.number().int().nonnegative().safe(),
		expiresAt: z.number().int().positive().safe(),
	})
	.strict()
	.superRefine((payload, context) => {
		if (payload.expiresAt <= payload.createdAt) {
			context.addIssue({
				code: "custom",
				path: ["expiresAt"],
				message: "must be after createdAt",
			});
		}
		if (
			payload.expiresAt - payload.createdAt >
			MAX_PUSH_NOTIFICATION_LIFETIME_MS
		) {
			context.addIssue({
				code: "custom",
				path: ["expiresAt"],
				message: "notification lifetime must not exceed 24 hours",
			});
		}
	});

export type PushPreferences = z.infer<typeof pushPreferencesSchema>;
export type BrowserPushSubscription = z.infer<
	typeof browserPushSubscriptionSchema
>;
export type SessionNotificationMode = z.infer<
	typeof sessionNotificationModeSchema
>;
export type WebPushNotificationPayload = z.infer<
	typeof webPushNotificationPayloadSchema
>;

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = Object.freeze({
	needs_attention: true,
	work_finished: false,
	privacy: "generic",
});

/** Keep notification navigation on the exact durable Raven session. */
export function safePushNotificationUrl(
	sessionId: string,
	candidate?: string,
): string {
	const fallback = `/raven?${new URLSearchParams({ session: sessionId })}`;
	if (!candidate?.startsWith("/")) return fallback;
	try {
		const parsed = new URL(candidate, "https://hlid.invalid");
		if (
			parsed.origin !== "https://hlid.invalid" ||
			parsed.pathname !== "/raven" ||
			parsed.searchParams.get("session") !== sessionId ||
			parsed.hash
		) {
			return fallback;
		}
		return `${parsed.pathname}${parsed.search}`.slice(0, 2_048);
	} catch {
		return fallback;
	}
}
