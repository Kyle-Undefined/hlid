import * as z from "zod";

export const MAX_PUSH_ENDPOINT_CHARS = 4_096;
export const MAX_PUSH_SESSION_ID_CHARS = 256;
export const MAX_PUSH_DEVICE_NAME_CHARS = 80;
export const MAX_PUSH_NOTIFICATION_PAYLOAD_BYTES = 8 * 1_024;
export const MAX_PUSH_NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_PUSH_NOTIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const PUSH_NOTIFICATION_TEST_URL =
	"/forge?category=experience&section=notifications";

export type PushNotificationSourceKind = "session" | "routine" | "system";
export type PushNotificationEventStatus =
	| "pending"
	| "deferred"
	| "batched"
	| "processed"
	| "expired"
	| "cancelled";
export type PushNotificationDeliveryStatus =
	| "pending"
	| "suppressed"
	| "queued"
	| "sent"
	| "failed"
	| "gone"
	| "expired";

export type PushNotificationEventSummary = {
	id: string;
	sourceKind: PushNotificationSourceKind;
	sourceId: string;
	category: PushNotificationCategory;
	reason: string | null;
	label: string | null;
	url: string | null;
	runtimeMs: number | null;
	pendingCount: number;
	occurredAt: number;
	expiresAt: number;
	groupKey: string | null;
	batchId: string | null;
	status: PushNotificationEventStatus;
	statusReason: string | null;
	nextAttemptAt: number | null;
};

export type PushNotificationDeliveryState = {
	status: PushNotificationDeliveryStatus;
	reason: string | null;
	nextAttemptAt: number | null;
	attemptCount: number;
	providerStatus: number | null;
	receiptAt: number | null;
	displayedAt: number | null;
	openedAt: number | null;
	dismissedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

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

export const pushNotificationCategorySchema = z.enum([
	"request",
	"problem",
	"completion",
]);

const legacyPushReminderMinutesSchema = z.union([
	z.literal(0),
	z.literal(5),
	z.literal(15),
	z.literal(30),
	z.literal(60),
]);

export const isoWeekdaySchema = z.number().int().min(1).max(7);

const pushQuietHoursShape = {
	timezone: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.refine((value) => {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
				return true;
			} catch {
				return false;
			}
		}, "must be an IANA time zone"),
	start: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must use 24-hour HH:mm"),
	end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must use 24-hour HH:mm"),
	weekdays: z
		.array(isoWeekdaySchema)
		.min(1)
		.max(7)
		.refine((value) => new Set(value).size === value.length, {
			message: "weekdays must be unique",
		}),
	allow_requests: z.boolean(),
	allow_problems: z.boolean(),
};

export const pushQuietHoursSchema = z.object(pushQuietHoursShape).strict();

const compatiblePushQuietHoursInputSchema = z
	.object({
		...pushQuietHoursShape,
		catch_up: z.boolean().optional(),
	})
	.strict()
	.transform(({ catch_up, ...quietHours }) => {
		void catch_up;
		return quietHours;
	});

export const pushPreferencesSchema = z
	.object({
		requests: z.boolean(),
		problems: z.boolean(),
		work_finished: z.boolean(),
		privacy: z.enum(["generic", "detailed"]),
		completion_min_runtime_minutes: completionMinimumRuntimeMinutesSchema,
		paused_until: z.number().int().nonnegative().safe().nullable(),
		paused_indefinitely: z.boolean().default(false),
		quiet_hours: pushQuietHoursSchema.nullable().default(null),
	})
	.strict();

const compatiblePushPreferencesInputSchema = z
	.object({
		requests: z.boolean(),
		problems: z.boolean(),
		work_finished: z.boolean(),
		privacy: z.enum(["generic", "detailed"]),
		completion_min_runtime_minutes: completionMinimumRuntimeMinutesSchema,
		paused_until: z.number().int().nonnegative().safe().nullable(),
		paused_indefinitely: z.boolean().default(false),
		quiet_hours: compatiblePushQuietHoursInputSchema.nullable().default(null),
		catch_up_after_pause: z.boolean().optional(),
		reminder_minutes: legacyPushReminderMinutesSchema.optional(),
	})
	.strict()
	.transform(({ catch_up_after_pause, reminder_minutes, ...preferences }) => {
		void catch_up_after_pause;
		void reminder_minutes;
		return preferences;
	});

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
		quiet_hours: null,
	}));

/** Accept older preference shapes while returning only the canonical fields. */
export const pushPreferencesInputSchema = z.union([
	compatiblePushPreferencesInputSchema,
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
		quiet_hours: compatiblePushQuietHoursInputSchema.nullable().optional(),
		catch_up_after_pause: z.boolean().optional(),
		reminder_minutes: legacyPushReminderMinutesSchema.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message: "at least one preference is required",
	})
	.transform((value) => {
		const {
			needs_attention,
			catch_up_after_pause,
			reminder_minutes,
			...canonical
		} = value;
		void catch_up_after_pause;
		void reminder_minutes;
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
		replaces_endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS).optional(),
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
		name: pushDeviceNameSchema.optional(),
		preferences: pushPreferencesPatchSchema.optional(),
		endpoint: z.string().url().max(MAX_PUSH_ENDPOINT_CHARS).optional(),
	})
	.strict()
	.refine(
		(value) => value.name !== undefined || value.preferences !== undefined,
		{ message: "a name or preferences patch is required" },
	);

export const deletePushDeviceSchema = z
	.object({ id: z.string().uuid() })
	.strict();

export const sessionNotificationModeSchema = z.enum([
	"default",
	"notify",
	"notify_once",
	"notify_completion_once",
	"mute",
]);

export const sessionNotificationScopeSchema = z.enum([
	"session",
	"delegation_tree",
]);

export const pushTargetDeviceIdsSchema = z
	.array(z.string().uuid())
	.min(1)
	.max(32)
	.refine((value) => new Set(value).size === value.length, {
		message: "notification device IDs must be unique",
	});

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
		scope: sessionNotificationScopeSchema.optional(),
		target_device_ids: pushTargetDeviceIdsSchema.nullable().optional(),
	})
	.strict();

export const pushDeliveryReceiptSchema = z
	.object({
		delivery_id: z.string().uuid(),
		status: z.enum(["displayed", "opened", "dismissed"]),
	})
	.strict();

export const pushNotificationBatchIdSchema = z
	.string()
	.min(8)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/);

export const pushNotificationBatchReadSchema = z
	.object({
		batch_id: pushNotificationBatchIdSchema,
		session_id: pushSessionIdSchema.optional(),
	})
	.strict();

const payloadBase = {
	version: z.literal(1),
	title: z.string().min(1).max(160),
	body: z.string().min(1).max(500),
	deliveryId: z.string().uuid().optional(),
	url: z.string().min(1).max(2_048).optional(),
	createdAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().positive().safe(),
};

const sessionPayloadFields = {
	sessionId: pushSessionIdSchema,
	sessionIds: z.array(pushSessionIdSchema).min(2).max(10).optional(),
	deliveryIds: z.array(z.string().uuid()).min(2).max(10).optional(),
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

const routinePayloadFields = {
	source: z.literal("routine"),
	routineId: z.string().uuid(),
	routineRunId: z.string().uuid(),
	reason: z.string().min(1).max(64).optional(),
};

export const webPushNotificationPayloadSchema = z
	.union([
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
				...routinePayloadFields,
				kind: z.literal("needs_attention"),
			})
			.strict(),
		z
			.object({
				...payloadBase,
				...routinePayloadFields,
				kind: z.literal("work_finished"),
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
		const sessionIds = "sessionIds" in payload ? payload.sessionIds : undefined;
		const deliveryIds =
			"deliveryIds" in payload ? payload.deliveryIds : undefined;
		const batchId = "batchId" in payload ? payload.batchId : undefined;
		const sessionId = "sessionId" in payload ? payload.sessionId : undefined;
		if (payload.kind === "needs_attention" && sessionIds) {
			context.addIssue({
				code: "custom",
				path: ["sessionIds"],
				message: "attention notifications cannot be batched",
			});
		}
		if (payload.kind !== "test" && Boolean(sessionIds) !== Boolean(batchId)) {
			context.addIssue({
				code: "custom",
				path: ["batchId"],
				message: "must be present exactly when sessionIds is present",
			});
		}
		if (
			payload.kind !== "test" &&
			sessionIds &&
			(new Set(sessionIds).size !== sessionIds.length ||
				!sessionId ||
				!sessionIds.includes(sessionId))
		) {
			context.addIssue({
				code: "custom",
				path: ["sessionIds"],
				message: "must contain unique ids including the primary session",
			});
		}
		if (payload.kind !== "test" && deliveryIds) {
			if (!sessionIds || deliveryIds.length !== sessionIds.length) {
				context.addIssue({
					code: "custom",
					path: ["deliveryIds"],
					message: "must be paired in order with every batched session",
				});
			}
			if (new Set(deliveryIds).size !== deliveryIds.length) {
				context.addIssue({
					code: "custom",
					path: ["deliveryIds"],
					message: "must contain unique delivery ids",
				});
			}
			if (payload.deliveryId) {
				context.addIssue({
					code: "custom",
					path: ["deliveryId"],
					message: "must be omitted when deliveryIds is present",
				});
			}
		}
	});

export type PushPreferences = z.output<typeof pushPreferencesSchema>;
export type PushPreferencesPatch = z.infer<typeof pushPreferencesPatchSchema>;
export type PushNotificationCategory = z.infer<
	typeof pushNotificationCategorySchema
>;
export type PushQuietHours = z.infer<typeof pushQuietHoursSchema>;
export type BrowserPushSubscription = z.infer<
	typeof browserPushSubscriptionSchema
>;
export type SessionNotificationMode = z.infer<
	typeof sessionNotificationModeSchema
>;
export type SessionNotificationScope = z.infer<
	typeof sessionNotificationScopeSchema
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
	quiet_hours: null,
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
		const attentionId = parsed.searchParams.get("attention_id");
		const allowedAttention =
			attention === null ||
			attention === "permission" ||
			attention === "question" ||
			attention === "plan_review";
		const uniqueKeys =
			parsed.searchParams.getAll("session").length === 1 &&
			parsed.searchParams.getAll("attention").length <= 1 &&
			parsed.searchParams.getAll("attention_id").length <= 1;
		const allowedAttentionId =
			attentionId === null ||
			(attention !== null &&
				attentionId.length >= 1 &&
				attentionId.length <= 128 &&
				/^[A-Za-z0-9._:-]+$/.test(attentionId));
		if (
			parsed.origin !== "https://hlid.invalid" ||
			parsed.pathname !== "/raven" ||
			parsed.searchParams.get("session") !== sessionId ||
			!allowedAttention ||
			!allowedAttentionId ||
			!uniqueKeys
		) {
			return fallback;
		}
		const normalized = new URLSearchParams({ session: sessionId });
		if (attention) normalized.set("attention", attention);
		if (attentionId) normalized.set("attention_id", attentionId);
		return `/raven?${normalized}`;
	} catch {
		return fallback;
	}
}

/** Keep Routine notifications on the exact Cockpit run that produced them. */
export function safeRoutineNotificationUrl(
	routineId: string,
	routineRunId: string,
	candidate?: string,
): string {
	const search = new URLSearchParams({
		routine: routineId,
		routine_run: routineRunId,
	});
	const fallback = `/?${search}`;
	if (!candidate?.startsWith("/")) return fallback;
	try {
		const parsed = new URL(candidate, "https://hlid.invalid");
		const allowedKeys = Array.from(parsed.searchParams.keys()).every(
			(key) => key === "routine" || key === "routine_run",
		);
		if (
			parsed.origin !== "https://hlid.invalid" ||
			parsed.pathname !== "/" ||
			parsed.searchParams.get("routine") !== routineId ||
			parsed.searchParams.get("routine_run") !== routineRunId ||
			parsed.searchParams.getAll("routine").length !== 1 ||
			parsed.searchParams.getAll("routine_run").length !== 1 ||
			!allowedKeys ||
			parsed.hash
		) {
			return fallback;
		}
		return fallback;
	} catch {
		return fallback;
	}
}
