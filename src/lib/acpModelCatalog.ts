import { z } from "zod";

/** Bounded model-catalog shape shared by the internal ACP route and Forge. */
const AcpModelOptionSchema = z.object({
	value: z.string().min(1).max(512),
	label: z.string().min(1).max(512),
	resolvedModel: z.string().max(512).optional(),
	description: z.string().max(4_000).optional(),
	isDefault: z.boolean().optional(),
	hidden: z.boolean().optional(),
	supportsAutoMode: z.boolean().optional(),
	inputModalities: z
		.array(z.enum(["text", "image", "audio"]))
		.max(3)
		.optional(),
	efforts: z
		.array(
			z.object({
				value: z.string().min(1).max(128),
				label: z.string().min(1).max(256),
				desc: z.string().max(2_000).optional(),
				isDefault: z.boolean().optional(),
			}),
		)
		.max(64)
		.optional(),
	serviceTiers: z
		.array(
			z.object({
				value: z.string().min(1).max(128),
				label: z.string().min(1).max(256),
				desc: z.string().max(2_000).optional(),
				isDefault: z.boolean().optional(),
			}),
		)
		.max(64)
		.optional(),
});

export const AcpModelCatalogSchema = z.array(AcpModelOptionSchema).max(2_000);
