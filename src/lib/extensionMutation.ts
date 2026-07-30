import { z } from "zod";

const extensionIdSchema = z.string().regex(/^[0-9a-f]{24}$/);
const expectedVersionSchema = z.string().max(128);

export const extensionMutationSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("install"),
		id: extensionIdSchema,
		environmentId: extensionIdSchema,
		reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
	}),
	z.object({
		action: z.literal("uninstall"),
		id: extensionIdSchema,
		environmentId: extensionIdSchema,
		expectedVersion: expectedVersionSchema,
	}),
	z.object({
		action: z.literal("update"),
		id: extensionIdSchema,
		environmentId: extensionIdSchema,
		expectedVersion: expectedVersionSchema,
	}),
	z
		.object({
			action: z.literal("set_enabled"),
			id: extensionIdSchema,
			environmentId: extensionIdSchema,
			expectedVersion: expectedVersionSchema,
			expectedEnabled: z.boolean(),
			enabled: z.boolean(),
		})
		.refine((input) => input.enabled !== input.expectedEnabled),
	z.object({
		action: z.literal("add_marketplace"),
		providerId: z.enum(["claude", "codex"]),
		environmentId: extensionIdSchema,
		source: z.string().min(1).max(2_048),
		ref: z.string().max(256).optional(),
		sparse: z.array(z.string().min(1).max(512)).max(20).optional(),
	}),
	z.object({
		action: z.literal("upgrade_marketplace"),
		id: extensionIdSchema,
		environmentId: extensionIdSchema,
		expectedSource: z.string().max(2_048),
	}),
	z.object({
		action: z.literal("remove_marketplace"),
		id: extensionIdSchema,
		environmentId: extensionIdSchema,
		expectedSource: z.string().max(2_048),
	}),
]);

export type ExtensionMutationInput = z.infer<typeof extensionMutationSchema>;
