import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch } from "#/lib/dbClient";
import { getConfig } from "#/lib/serverFns/config";
import type { VaultMcpConfig, VaultMcpServer } from "./McpServerForm";

export const getVaultMcpFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { readVaultMcpFile } = await import("#/lib/vaultMcp");
		const config = await getConfig();
		if (!config.vault.path) return { servers: [] as VaultMcpServer[] };
		return readVaultMcpFile(config.vault.path) as {
			servers: VaultMcpServer[];
		};
	},
);

const serverMapSchema = z.record(z.string(), z.unknown());

export const writeVaultMcpFn = createServerFn({ method: "POST" })
	.validator(
		(raw) =>
			z.object({ servers: serverMapSchema }).parse(raw) as {
				servers: Record<string, VaultMcpConfig>;
			},
	)
	.handler(async ({ data }) => {
		const { writeVaultMcpFile } = await import("#/lib/vaultMcp");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");
		writeVaultMcpFile(config.vault.path, data.servers);
	});

export const toggleVaultMcpFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z.object({ name: z.string(), disabled: z.boolean() }).parse(raw),
	)
	.handler(async ({ data }) => {
		const { toggleVaultMcpFile } = await import("#/lib/vaultMcp");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");
		toggleVaultMcpFile(config.vault.path, data.name, data.disabled);
	});

export const getLiveMcpStatusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		try {
			const res = await dbFetch("/mcp-status");
			return (await res.json()) as Array<{
				name: string;
				status: string;
				scope?: string;
			}>;
		} catch {
			return [];
		}
	},
);

export const getAgentMcpFn = createServerFn({ method: "GET" })
	.validator((raw) => z.string().parse(raw))
	.handler(async ({ data: agentPath }) => {
		const { readAgentMcpFile, resolveAuthorizedAgentPath } = await import(
			"#/lib/agentMcp"
		);
		const config = await getConfig();
		const requested = resolveAuthorizedAgentPath(agentPath, config);
		return readAgentMcpFile(requested) as { servers: VaultMcpServer[] };
	});

export const writeAgentMcpFn = createServerFn({ method: "POST" })
	.validator(
		(raw) =>
			z
				.object({ agentPath: z.string(), servers: serverMapSchema })
				.parse(raw) as {
				agentPath: string;
				servers: Record<string, VaultMcpConfig>;
			},
	)
	.handler(async ({ data }) => {
		const { resolveAuthorizedAgentPath, writeAgentMcpFile } = await import(
			"#/lib/agentMcp"
		);
		const config = await getConfig();
		const requested = resolveAuthorizedAgentPath(data.agentPath, config);
		writeAgentMcpFile(requested, data.servers);
	});

export const toggleAgentMcpFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({
				agentPath: z.string(),
				name: z.string(),
				disabled: z.boolean(),
			})
			.parse(raw),
	)
	.handler(async ({ data }) => {
		const { resolveAuthorizedAgentPath, toggleAgentMcpFile } = await import(
			"#/lib/agentMcp"
		);
		const config = await getConfig();
		const requested = resolveAuthorizedAgentPath(data.agentPath, config);
		toggleAgentMcpFile(requested, data.name, data.disabled);
	});
