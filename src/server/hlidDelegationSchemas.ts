import { z } from "zod";
import { HLID_DELEGATION_MAX_TASK_CHARS } from "../lib/hlidDelegation";

export * from "../lib/hlidDelegation";

export const hlidDelegationHandoffSchema = z
	.object({
		visible_transcript: z.boolean().optional(),
		selected_skills: z.boolean().optional(),
		selected_relics: z.boolean().optional(),
		exact_references: z.boolean().optional(),
	})
	.strict();

export const delegateHlidAgentSchema = z.object({
	task: z.string().trim().min(1).max(HLID_DELEGATION_MAX_TASK_CHARS),
	provider: z.string().trim().min(1).max(120),
	model: z.string().trim().min(1).max(200).optional(),
	effort: z.string().trim().min(1).max(80).optional(),
	service_tier: z.string().trim().min(1).max(120).optional(),
	cwd: z.string().trim().min(1).max(4_096).optional(),
	workspace_mode: z.enum(["default", "shared", "worktree"]).optional(),
	permission_mode: z
		.enum([
			"default",
			"acceptEdits",
			"bypassPermissions",
			"plan",
			"dontAsk",
			"auto",
		])
		.optional(),
	handoff: hlidDelegationHandoffSchema.optional(),
});

export const inspectHlidAgentSchema = z.object({
	id: z.string().uuid(),
});

export const listHlidAgentsSchema = z.object({
	limit: z.number().int().min(1).max(100).optional(),
});

export const waitHlidAgentSchema = z.object({
	id: z.string().uuid(),
	wait_seconds: z.number().int().min(1).max(60).optional(),
});

export const steerHlidAgentSchema = z.object({
	id: z.string().uuid(),
	instruction: z.string().trim().min(1).max(HLID_DELEGATION_MAX_TASK_CHARS),
});

export const cancelHlidAgentSchema = z.object({
	id: z.string().uuid(),
});

export const cleanupHlidWorktreeSchema = z.object({
	id: z.string().uuid(),
});

export const resumeHlidAgentSchema = z.object({
	id: z.string().uuid(),
	instruction: z.string().trim().min(1).max(HLID_DELEGATION_MAX_TASK_CHARS),
	permission_mode: z
		.enum([
			"default",
			"acceptEdits",
			"bypassPermissions",
			"plan",
			"dontAsk",
			"auto",
		])
		.optional(),
});

export type DelegateHlidAgentInput = z.infer<typeof delegateHlidAgentSchema>;
export type ResumeHlidAgentInput = z.infer<typeof resumeHlidAgentSchema>;
