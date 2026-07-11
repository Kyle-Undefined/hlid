import { z } from "zod";
import { AgentSchema } from "#/config";

export const sessionIdSchema = z
	.string()
	.trim()
	.min(1, "session id is required")
	.max(512, "session id is too long");

export const sessionPageSchema = z.object({
	page: z.number().int().min(1).max(1_000_000),
	size: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]),
});

export const sessionDeleteSchema = z.object({ id: sessionIdSchema });

export const sessionRenameSchema = z.object({
	id: sessionIdSchema,
	label: z.string().trim().min(1).max(200),
});

export const sessionCleanupSchema = z.object({
	days: z.number().int().min(1).max(36_500),
});

export const terminalSessionSchema = z.object({
	id: sessionIdSchema,
	label: z.string().trim().min(1).max(200),
	model: z.string().trim().min(1).max(200),
});

export const eventLogQuerySchema = z.object({
	page: z.number().int().min(1).max(1_000_000),
	size: z.number().int().min(1).max(100),
	level: z.enum(["all", "error", "warn", "info"]),
});

export const agentPathSchema = z.string().trim().min(1).max(4096);

const persistedAgentSchema = AgentSchema.extend({
	path: agentPathSchema,
	name: z.string().trim().min(1).max(200).optional(),
	provider: z.string().trim().min(1).max(100).default("claude"),
	model: z.string().trim().min(1).max(200).optional(),
	effort: z.string().trim().min(1).max(100).optional(),
	recap_model: z.string().trim().min(1).max(200).optional(),
});

export const agentListSchema = z.array(persistedAgentSchema).max(100);
