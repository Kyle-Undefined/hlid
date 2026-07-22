import * as z from "zod";
import { MAX_RELIC_REFERENCES, MAX_VAULT_REFERENCES } from "./vaultReferences";

export const routineScheduleSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("once"),
		at: z.string().datetime({ offset: true }),
	}),
	z.object({
		kind: z.literal("interval"),
		everyMinutes: z.number().int().min(1).max(525_600),
		anchorAt: z.string().datetime({ offset: true }),
	}),
	z.object({
		kind: z.literal("daily"),
		time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
	}),
	z.object({
		kind: z.literal("weekly"),
		time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
		weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
	}),
]);

export type RoutineSchedule = z.infer<typeof routineScheduleSchema>;

export const routinePermissionModeSchema = z.enum([
	"read_only",
	"preapproved",
	"full_access",
]);
export type RoutinePermissionMode = z.infer<typeof routinePermissionModeSchema>;

export const routineDeliverySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("relic") }),
	z.object({ kind: z.literal("daily_append") }),
	z.object({ kind: z.literal("capture") }),
	z.object({
		kind: z.literal("note_append"),
		path: z.string().min(1).max(1_024),
	}),
]);
export type RoutineDelivery = z.infer<typeof routineDeliverySchema>;

export const routineGrantCapabilitySchema = z.enum([
	"fs.read",
	"fs.write",
	"shell.exec",
	"obsidian.call",
	"mcp.call",
	"hlid.call",
	"tool.call",
]);
export type RoutineGrantCapability = z.infer<
	typeof routineGrantCapabilitySchema
>;

const jsonScalarSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);

export const routinePermissionGrantInputSchema = z.object({
	id: z.string().uuid().optional(),
	capability: routineGrantCapabilitySchema,
	tool: z.string().min(1).max(256).optional(),
	path: z.string().min(1).max(4_096).optional(),
	pathPrefix: z.string().min(1).max(4_096).optional(),
	command: z.string().min(1).max(16_384).optional(),
	input: z.record(z.string().max(256), jsonScalarSchema).optional(),
	maxUsesPerRun: z.number().int().min(1).max(10_000).optional(),
	expiresAt: z.number().int().positive().optional(),
});
export type RoutinePermissionGrantInput = z.infer<
	typeof routinePermissionGrantInputSchema
>;

export const routineDefinitionSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		prompt: z.string().trim().max(200_000),
		enabled: z.boolean().default(false),
		schedule: routineScheduleSchema,
		timezone: z.string().trim().min(1).max(128),
		providerId: z.string().trim().min(1).max(128),
		model: z.string().max(256).default(""),
		effort: z.string().max(64).default(""),
		agentCwd: z.string().trim().min(1).max(4_096),
		agentName: z.string().trim().min(1).max(256),
		skillContexts: z.array(z.string().min(1).max(4_096)).max(16).default([]),
		providerCommands: z
			.array(z.string().trim().min(1).max(256))
			.max(16)
			.default([]),
		vaultReferences: z
			.array(z.string().min(1).max(1_024))
			.max(MAX_VAULT_REFERENCES)
			.default([]),
		relicIds: z.array(z.string().uuid()).max(MAX_RELIC_REFERENCES).default([]),
		permissionMode: routinePermissionModeSchema.default("preapproved"),
		grants: z.array(routinePermissionGrantInputSchema).max(128).default([]),
		deliveries: z.array(routineDeliverySchema).max(8).default([]),
		catchUpWindowMinutes: z.number().int().min(0).max(10_080).default(360),
		noOverlap: z.boolean().default(true),
	})
	.superRefine((definition, context) => {
		if (
			!definition.prompt &&
			definition.skillContexts.length === 0 &&
			definition.providerCommands.length === 0
		) {
			context.addIssue({
				code: "custom",
				path: ["prompt"],
				message: "Add a prompt or select at least one skill",
			});
		}
	});

export type RoutineDefinition = z.output<typeof routineDefinitionSchema>;

export const routineCreateSchema = routineDefinitionSchema;
export const routineUpdateSchema = z.object({
	id: z.string().uuid(),
	definition: routineDefinitionSchema,
});

export const routineIdSchema = z.string().uuid();

export const routineListSchema = z.object({
	includeArchived: z.boolean().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export type RoutineStatus =
	| "claimed"
	| "running"
	| "succeeded"
	| "delivery_error"
	| "action_required"
	| "failed"
	| "provider_unavailable"
	| "interrupted"
	| "skipped_overlap"
	| "missed"
	| "cancelled";

export type RoutineSummary = {
	id: string;
	name: string;
	prompt: string;
	enabled: boolean;
	archived: boolean;
	revision: number;
	schedule: RoutineSchedule;
	timezone: string;
	nextRunAt: number | null;
	providerId: string;
	model: string;
	effort: string;
	agentCwd: string;
	agentName: string;
	skillContexts: string[];
	providerCommands: string[];
	vaultReferences: string[];
	relicIds: string[];
	permissionMode: RoutinePermissionMode;
	grants: RoutinePermissionGrantInput[];
	deliveries: RoutineDelivery[];
	catchUpWindowMinutes: number;
	noOverlap: boolean;
	pausedReason: string | null;
	authorizationFingerprint: string;
	createdAt: number;
	updatedAt: number;
	lastRun?: {
		id: string;
		status: RoutineStatus;
		scheduledFor: number;
		startedAt: number | null;
		finishedAt: number | null;
		sessionId: string | null;
		error: string | null;
		actionRequired: string | null;
	} | null;
};
