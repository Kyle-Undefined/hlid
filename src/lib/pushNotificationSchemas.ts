import * as z from "zod";

export const MAX_PUSH_ENDPOINT_CHARS = 4_096;
export const MAX_PUSH_SESSION_ID_CHARS = 256;
export const MAX_PUSH_DEVICE_NAME_CHARS = 80;
export const MAX_PUSH_NOTIFICATION_PAYLOAD_BYTES = 8 * 1_024;
export const MAX_PUSH_NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_PUSH_NOTIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const PUSH_NOTIFICATION_TEST_URL =
	"/forge?category=experience&section=notifications";

const base64UrlSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9_-]+$/, "must be unpadded base64url");

function hasNoControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

export const completionMinimumRuntimeMinutesSchema = z.union([
	z.literal(0),
	z.literal(1),
	z.literal(5),
	z.literal(10),
]);

export const pushPreferencesSchema = z
	.object({
		requests: z.boolean(),
		problems: z.boolean(),
		work_finished: z.boolean(),
		privacy: z.enum(["generic", "detailed"]),
		completion_min_runtime_minutes: completionMinimumRuntimeMinutesSchema,
		paused_until: z.number().int().nonnegative().safe().nullable(),
		paused_indefinitely: z.boolean().default(false),
	})
	.strict();

const legacyPushPreferencesSchema = z
	.object({
		needs_attention: z.boolean(),
		work_finished: z.boolean(),
		privacy: z.enum(["generic", "detailed"]),
	})
	.strict()
	.transform((value) => ({
		requests: value.needs_attention,
		problems: value.needs_attention,
		work_finished: value.work_finished,
		privacy: value.privacy,
		completion_min_runtime_minutes: 0 as const,
		paused_until: null,
		paused_indefinitely: false,
	}));

/** Accept the prerelease category shape while always returning the v2 shape. */
export const pushPreferencesInputSchema = z.union([
	pushPreferencesSchema,
	legacyPushPreferencesSchema,
]);

export const pushPreferencesPatchSchema = z
	.object({
		requests: z.boolean().optional(),
		problems: z.boolean().optional(),
		needs_attention: z.boolean().optional(),
		work_finished: z.boolean().optional(),
		privacy: z.enum(["generic", "detailed"]).optional(),
		completion_min_runtime_minutes:
			completionMinimumRuntimeMinutesSchema.optional(),
		paused_until: z.number().int().nonnegative().safe().nullable().optional(),
		paused_indefinitely: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message: "at least one preference is required",
	})
	.transform((value) => {
		const { needs_attention, ...canonical } = value;
		return {
			...canonical,
			...(canonical.requests === undefined && needs_attention !== undefined
				? { requests: needs_attention }
				: {}),
			...(canonical.problems === undefined && needs_attention !== undefined
				? { problems: needs_attention }
				: {}),
		};
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

export const pushDeviceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_PUSH_DEVICE_NAME_CHARS)
	.refine(hasNoControlCharacters, {
		message: "must not contain control characters",
	});

export const subscribePushSchema = z
	.object({
		subscription: browserPushSubscriptionSchema,
		preferences: pushPreferencesInputSchema.optional(),
		device_name: pushDeviceNameSchema.optional(),
	})
	.strict();

export const pushEndpointSchema = z
	.object({ endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS) })
	.strict();

export const pushNotificationTestScenarioSchema = z.enum([
	"delivery",
	"permission",
	"question",
	"plan_review",
	"problem",
	"work_finished",
	"work_finished_batch",
]);

export const pushTestSchema = z
	.object({
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS),
		scenario: pushNotificationTestScenarioSchema.optional(),
	})
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

export const listPushDevicesSchema = z
	.object({
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS).optional(),
	})
	.strict();

export const updatePushDeviceSchema = z
	.object({
		id: z.string().uuid(),
		name: pushDeviceNameSchema,
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS).optional(),
	})
	.strict();

export const deletePushDeviceSchema = z
	.object({ id: z.string().uuid() })
	.strict();

export const sessionNotificationModeSchema = z.enum([
	"default",
	"notify",
	"notify_once",
	"mute",
]);

export const pushSessionIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_PUSH_SESSION_ID_CHARS)
	.refine(hasNoControlCharacters, {
		message: "must not contain control characters",
	});

export const updatePushSessionOverrideSchema = z
	.object({
		session_id: pushSessionIdSchema,
		mode: sessionNotificationModeSchema,
	})
	.strict();

const payloadBase = {
	version: z.literal(1),
	title: z.string().min(1).max(160),
	body: z.string().min(1).max(500),
	url: z.string().min(1).max(2_048).optional(),
	createdAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().positive().safe(),
};

const sessionPayloadFields = {
	sessionId: pushSessionIdSchema,
	sessionIds: z.array(pushSessionIdSchema).min(2).max(10).optional(),
	batchId: z
		.string()
		.min(8)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	reason: z.string().min(1).max(64).optional(),
	sessionLabel: z.string().min(1).max(160).optional(),
	durationMs: z.number().int().nonnegative().safe().optional(),
};

export const webPushNotificationPayloadSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				...payloadBase,
				...sessionPayloadFields,
				kind: z.literal("needs_attention"),
			})
			.strict(),
		z
			.object({
				...payloadBase,
				...sessionPayloadFields,
				kind: z.literal("work_finished"),
			})
			.strict(),
		z
			.object({
				...payloadBase,
				kind: z.literal("test"),
			})
			.strict(),
	])
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
		if (payload.kind === "needs_attention" && payload.sessionIds) {
			context.addIssue({
				code: "custom",
				path: ["sessionIds"],
				message: "attention notifications cannot be batched",
			});
		}
		if (
			payload.kind !== "test" &&
			Boolean(payload.sessionIds) !== Boolean(payload.batchId)
		) {
			context.addIssue({
				code: "custom",
				path: ["batchId"],
				message: "must be present exactly when sessionIds is present",
			});
		}
		if (
			payload.kind !== "test" &&
			payload.sessionIds &&
			(new Set(payload.sessionIds).size !== payload.sessionIds.length ||
				!payload.sessionIds.includes(payload.sessionId))
		) {
			context.addIssue({
				code: "custom",
				path: ["sessionIds"],
				message: "must contain unique ids including the primary session",
			});
		}
	});

export type PushPreferences = z.infer<typeof pushPreferencesSchema>;
export type PushPreferencesPatch = z.infer<typeof pushPreferencesPatchSchema>;
export type BrowserPushSubscription = z.infer<
	typeof browserPushSubscriptionSchema
>;
export type SessionNotificationMode = z.infer<
	typeof sessionNotificationModeSchema
>;
export type PushNotificationTestScenario = z.infer<
	typeof pushNotificationTestScenarioSchema
>;
export type WebPushNotificationPayload = z.infer<
	typeof webPushNotificationPayloadSchema
>;

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = Object.freeze({
	requests: true,
	problems: true,
	work_finished: false,
	privacy: "generic",
	completion_min_runtime_minutes: 0,
	paused_until: null,
	paused_indefinitely: false,
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
		const attention = parsed.searchParams.get("attention");
		const allowedAttention =
			attention === null ||
			attention === "permission" ||
			attention === "question" ||
			attention === "plan_review";
		const allowedKeys = Array.from(parsed.searchParams.keys()).every(
			(key) => key === "session" || key === "attention",
		);
		const uniqueKeys =
			parsed.searchParams.getAll("session").length === 1 &&
			parsed.searchParams.getAll("attention").length <= 1;
		if (
			parsed.origin !== "https://hlid.invalid" ||
			parsed.pathname !== "/raven" ||
			parsed.searchParams.get("session") !== sessionId ||
			!allowedAttention ||
			!allowedKeys ||
			!uniqueKeys ||
			parsed.hash
		) {
			return fallback;
		}
		const normalized = new URLSearchParams({ session: sessionId });
		if (attention) normalized.set("attention", attention);
		return `/raven?${normalized}`;
	} catch {
		return fallback;
	}
}
