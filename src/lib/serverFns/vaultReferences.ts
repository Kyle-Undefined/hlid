import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const vaultReferenceSearchSchema = z.object({
	query: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

const relicReferenceSearchSchema = z.object({
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

export const searchRelicReferencesFn = createServerFn({ method: "GET" })
	.validator((raw) => relicReferenceSearchSchema.parse(raw))
	.handler(async ({ data }) => {
		const { listAttachments } = await import("#/db/attachments");
		const limit = data.limit ?? 8;
		const result = await listAttachments({
			search: data.query?.trim() || undefined,
			sort: "created_at",
			dir: "desc",
			limit,
		});
		return {
			items: result.rows.map((row) => ({
				id: row.id,
				path: row.path,
				filename: row.filename,
				mime: row.mime,
				kind: row.kind,
				createdAt: row.created_at,
				category: row.category ?? "other",
			})),
			total: result.total,
			truncated: result.total > result.rows.length,
		};
	});
