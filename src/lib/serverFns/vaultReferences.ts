import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const vaultReferenceSearchSchema = z.object({
	query: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

export const searchVaultReferencesFn = createServerFn({ method: "GET" })
	.validator((raw) => vaultReferenceSearchSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { searchVaultReferences }] = await Promise.all([
			import("#/server/config"),
			import("#/server/vaultReferences"),
		]);
		const config = loadConfig();
		return searchVaultReferences({
			vaultPath: config.vault.path,
			vaultName: config.vault.name,
			query: data.query,
			limit: data.limit,
		});
	});
