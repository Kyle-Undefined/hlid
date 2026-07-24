import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const vaultReferenceSearchSchema = z.object({
	query: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	notesOnly: z.boolean().optional(),
});

const relicReferenceSearchSchema = z.object({
	query: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).optional(),
	retainedOnly: z.boolean().optional(),
	ids: z.array(z.string().uuid()).max(16).optional(),
});

const workspaceReferenceSearchSchema = z.object({
	agentCwd: z.string().min(1).max(4096),
	query: z.string().max(512).optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

const workspaceReferencePreviewSchema = z.object({
	agentCwd: z.string().min(1).max(4096),
	relativePath: z.string().min(1).max(4096),
});

const vaultReferencePreviewSchema = z.object({
	relativePath: z.string().min(1).max(4096),
});

function relicReferenceItem(row: {
	id: string;
	path: string;
	filename: string;
	mime: string;
	kind: string;
	created_at: number;
	category?: string;
}) {
	return {
		id: row.id,
		path: row.path,
		filename: row.filename,
		mime: row.mime,
		kind: row.kind,
		createdAt: row.created_at,
		category: row.category ?? "other",
	};
}

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
			notesOnly: data.notesOnly,
		});
	});

export const previewVaultReferenceFn = createServerFn({ method: "GET" })
	.validator((raw) => vaultReferencePreviewSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { readObsidianNote }, { previewVaultReference }] =
			await Promise.all([
				import("#/server/config"),
				import("#/server/obsidianCli"),
				import("#/server/vaultReferences"),
			]);
		const config = loadConfig();
		return previewVaultReference({
			vaultPath: config.vault.path,
			relativePath: data.relativePath,
			read: (relativePath) => readObsidianNote(config.vault.name, relativePath),
		});
	});

export const searchRelicReferencesFn = createServerFn({ method: "GET" })
	.validator((raw) => relicReferenceSearchSchema.parse(raw))
	.handler(async ({ data }) => {
		const { getAttachment, listAttachments } = await import("#/db/attachments");
		if (data.ids?.length) {
			const rows = (
				await Promise.all(data.ids.map((id) => getAttachment(id)))
			).filter((row): row is NonNullable<typeof row> =>
				Boolean(row && (!data.retainedOnly || row.retention === "retained")),
			);
			return {
				items: rows.map((row) => relicReferenceItem(row)),
				total: rows.length,
				truncated: false,
			};
		}
		const limit = data.limit ?? 8;
		const result = await listAttachments({
			search: data.query?.trim() || undefined,
			retention: data.retainedOnly ? "retained" : undefined,
			sort: "created_at",
			dir: "desc",
			limit,
		});
		return {
			items: result.rows.map((row) => relicReferenceItem(row)),
			total: result.total,
			truncated: result.total > result.rows.length,
		};
	});

export const searchWorkspaceReferencesFn = createServerFn({ method: "GET" })
	.validator((raw) => workspaceReferenceSearchSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { searchWorkspaceReferences }] = await Promise.all([
			import("#/server/config"),
			import("#/server/workspaceReferences"),
		]);
		return searchWorkspaceReferences({
			config: loadConfig(),
			agentCwd: data.agentCwd,
			query: data.query,
			limit: data.limit,
		});
	});

export const previewWorkspaceReferenceFn = createServerFn({ method: "GET" })
	.validator((raw) => workspaceReferencePreviewSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { previewWorkspaceReference }] = await Promise.all([
			import("#/server/config"),
			import("#/server/workspaceReferences"),
		]);
		return previewWorkspaceReference({
			config: loadConfig(),
			agentCwd: data.agentCwd,
			relativePath: data.relativePath,
		});
	});

export const selectWorkspaceReferenceFn = createServerFn({ method: "GET" })
	.validator((raw) => workspaceReferencePreviewSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { selectWorkspaceReference }] = await Promise.all([
			import("#/server/config"),
			import("#/server/workspaceReferences"),
		]);
		return selectWorkspaceReference({
			config: loadConfig(),
			agentCwd: data.agentCwd,
			relativePath: data.relativePath,
		});
	});
