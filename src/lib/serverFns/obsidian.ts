import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const relativePathSchema = z.string().trim().min(1).max(4_096);

const appendSchema = z.object({
	destination: z.enum(["active", "daily"]),
	content: z.string().min(1).max(20_000),
});

export type ObsidianCliStatus =
	import("#/server/obsidianCli").ObsidianCliStatus;
export type ObsidianConnection =
	import("#/server/obsidianCli").ObsidianConnection;

export const getObsidianStatusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getObsidianCliStatus } = await import("#/server/obsidianCli");
		return getObsidianCliStatus();
	},
);

export const testObsidianConnectionFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const [{ loadConfig }, { testObsidianConnection }] = await Promise.all([
		import("#/server/config"),
		import("#/server/obsidianCli"),
	]);
	return testObsidianConnection(loadConfig().vault.name);
});

export const getActiveObsidianNoteFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const [{ loadConfig }, { getActiveObsidianNote, obsidianReferenceItem }] =
		await Promise.all([
			import("#/server/config"),
			import("#/server/obsidianCli"),
		]);
	const config = loadConfig();
	const relativePath = await getActiveObsidianNote(config.vault.name);
	const { resolveVaultReferences } = await import("#/server/vaultReferences");
	const [resolved] = await resolveVaultReferences({
		vaultPath: config.vault.path,
		references: [relativePath],
	});
	if (!resolved) {
		throw new Error(
			"The active Obsidian note is not inside Hlid's configured vault.",
		);
	}
	return obsidianReferenceItem(resolved.relativePath);
});

export const openObsidianNoteFn = createServerFn({ method: "POST" })
	.validator((raw) => relativePathSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { openObsidianNote }, { resolveVaultReferences }] =
			await Promise.all([
				import("#/server/config"),
				import("#/server/obsidianCli"),
				import("#/server/vaultReferences"),
			]);
		const config = loadConfig();
		const [resolved] = await resolveVaultReferences({
			vaultPath: config.vault.path,
			references: [data],
		});
		if (!resolved) throw new Error("The requested vault note was not found.");
		await openObsidianNote(config.vault.name, resolved.relativePath);
		return { ok: true };
	});

export const appendToObsidianFn = createServerFn({ method: "POST" })
	.validator((raw) => appendSchema.parse(raw))
	.handler(async ({ data }) => {
		const [{ loadConfig }, { appendToObsidian }] = await Promise.all([
			import("#/server/config"),
			import("#/server/obsidianCli"),
		]);
		await appendToObsidian(
			loadConfig().vault.name,
			data.destination,
			data.content,
		);
		return { ok: true };
	});
