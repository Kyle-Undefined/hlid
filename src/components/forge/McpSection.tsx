import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ConfirmAction } from "#/components/ConfirmAction";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import { dbFetch } from "#/lib/dbClient";
import type { ServerMessage } from "#/server/protocol";
import { Section } from "./fields";
import type { VaultMcpConfig, VaultMcpServer } from "./McpServerForm";
import {
	AddMcpServerForm,
	computeInitialForm,
	EditMcpServerForm,
} from "./McpServerForm";

// ─── Server functions ─────────────────────────────────────────────────────────

export const getVaultMcpFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const config = await getConfig();
		if (!config.vault.path) return { servers: [] as VaultMcpServer[] };

		let mcpMap: Record<string, VaultMcpConfig> = {};
		try {
			const raw = readFileSync(join(config.vault.path, ".mcp.json"), "utf8");
			mcpMap =
				(JSON.parse(raw) as { mcpServers?: Record<string, VaultMcpConfig> })
					.mcpServers ?? {};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		let disabled: string[] = [];
		try {
			const raw = readFileSync(
				join(config.vault.path, ".claude", "settings.local.json"),
				"utf8",
			);
			disabled =
				(JSON.parse(raw) as { disabledMcpjsonServers?: string[] })
					.disabledMcpjsonServers ?? [];
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		return {
			servers: Object.entries(mcpMap).map(([name, cfg]) => ({
				name,
				config: cfg,
				disabled: disabled.includes(name),
			})),
		};
	},
);

const writeVaultMcpSchema = z.object({
	servers: z.record(z.string(), z.unknown()),
});

export const writeVaultMcpFn = createServerFn({ method: "POST" })
	.inputValidator(
		(raw): { servers: Record<string, VaultMcpConfig> } =>
			writeVaultMcpSchema.parse(raw) as {
				servers: Record<string, VaultMcpConfig>;
			},
	)
	.handler(async ({ data }) => {
		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");
		writeFileSync(
			join(config.vault.path, ".mcp.json"),
			JSON.stringify({ mcpServers: data.servers }, null, 2),
			"utf8",
		);
	});

const toggleVaultMcpSchema = z.object({
	name: z.string(),
	disabled: z.boolean(),
});

export const toggleVaultMcpFn = createServerFn({ method: "POST" })
	.inputValidator((raw) => toggleVaultMcpSchema.parse(raw))
	.handler(async ({ data }) => {
		const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");

		const settingsPath = join(
			config.vault.path,
			".claude",
			"settings.local.json",
		);
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
				string,
				unknown
			>;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		const disabledSet = new Set<string>(
			(settings.disabledMcpjsonServers as string[] | undefined) ?? [],
		);
		if (data.disabled) disabledSet.add(data.name);
		else disabledSet.delete(data.name);
		settings.disabledMcpjsonServers = [...disabledSet];

		mkdirSync(join(config.vault.path, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
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

// ─── Agent-scoped server functions ───────────────────────────────────────────

export const getAgentMcpFn = createServerFn({ method: "GET" })
	.inputValidator((raw) => z.string().parse(raw))
	.handler(async ({ data: agentPath }) => {
		const { readFileSync } = await import("node:fs");
		const { join, resolve } = await import("node:path");
		const { expandTilde, samePath } = await import("#/lib/paths");
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested))) {
			throw new Error("Unauthorized");
		}

		let mcpMap: Record<string, VaultMcpConfig> = {};
		try {
			const raw = readFileSync(join(requested, ".mcp.json"), "utf8");
			mcpMap =
				(JSON.parse(raw) as { mcpServers?: Record<string, VaultMcpConfig> })
					.mcpServers ?? {};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		let disabled: string[] = [];
		try {
			const raw = readFileSync(
				join(requested, ".claude", "settings.local.json"),
				"utf8",
			);
			disabled =
				(JSON.parse(raw) as { disabledMcpjsonServers?: string[] })
					.disabledMcpjsonServers ?? [];
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		return {
			servers: Object.entries(mcpMap).map(([name, cfg]) => ({
				name,
				config: cfg,
				disabled: disabled.includes(name),
			})),
		};
	});

const writeAgentMcpSchema = z.object({
	agentPath: z.string(),
	servers: z.record(z.string(), z.unknown()),
});

export const writeAgentMcpFn = createServerFn({ method: "POST" })
	.inputValidator(
		(raw): { agentPath: string; servers: Record<string, VaultMcpConfig> } =>
			writeAgentMcpSchema.parse(raw) as {
				agentPath: string;
				servers: Record<string, VaultMcpConfig>;
			},
	)
	.handler(async ({ data }) => {
		const { writeFileSync } = await import("node:fs");
		const { join, resolve } = await import("node:path");
		const { expandTilde, samePath } = await import("#/lib/paths");
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(data.agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested))) {
			throw new Error("Unauthorized");
		}
		writeFileSync(
			join(requested, ".mcp.json"),
			JSON.stringify({ mcpServers: data.servers }, null, 2),
			"utf8",
		);
	});

const toggleAgentMcpSchema = z.object({
	agentPath: z.string(),
	name: z.string(),
	disabled: z.boolean(),
});

export const toggleAgentMcpFn = createServerFn({ method: "POST" })
	.inputValidator((raw) => toggleAgentMcpSchema.parse(raw))
	.handler(async ({ data }) => {
		const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { join, resolve } = await import("node:path");
		const { expandTilde, samePath } = await import("#/lib/paths");
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(data.agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested))) {
			throw new Error("Unauthorized");
		}

		const settingsPath = join(requested, ".claude", "settings.local.json");
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
				string,
				unknown
			>;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}

		const disabledSet = new Set<string>(
			(settings.disabledMcpjsonServers as string[] | undefined) ?? [],
		);
		if (data.disabled) disabledSet.add(data.name);
		else disabledSet.delete(data.name);
		settings.disabledMcpjsonServers = [...disabledSet];

		mkdirSync(join(requested, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
	});

// ─── Component ────────────────────────────────────────────────────────────────

export function McpSection({ vaultPath }: { vaultPath: string }) {
	const [servers, setServers] = useState<VaultMcpServer[] | null>(null);
	const [liveStatus, setLiveStatus] = useState<Map<string, string>>(new Map());
	const [cloudServers, setCloudServers] = useState<
		Array<{ name: string; status: string }>
	>([]);
	const [showAdd, setShowAdd] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [editingServer, setEditingServer] = useState<string | null>(null);
	const [probing, setProbing] = useState(false);

	const onMessage = useCallback((msg: ServerMessage) => {
		// Ignore agent-scoped MCP status — those belong to AgentMcpSection.
		if (msg.type === "mcp_status" && !msg.agent_cwd) {
			setLiveStatus(new Map(msg.servers.map((s) => [s.name, s.status])));
			setCloudServers(
				msg.servers
					.filter((s) => s.scope === "claudeai")
					.map((s) => ({ name: s.name, status: s.status })),
			);
			setProbing(false);
		}
	}, []);
	const { send } = useWs(onMessage);

	useEffect(() => {
		getVaultMcpFn()
			.then((d) => setServers(d.servers))
			.catch((e) => {
				console.error("[mcp] Failed to load servers:", e);
				setServers([]);
			});
		getLiveMcpStatusFn()
			.then((statuses) => {
				setLiveStatus(new Map(statuses.map((s) => [s.name, s.status])));
				setCloudServers(
					statuses
						.filter((s) => s.scope === "claudeai")
						.map((s) => ({ name: s.name, status: s.status })),
				);
			})
			.catch((e) => console.error("[mcp] Failed to load status:", e));
	}, []);

	function statusDot(name: string): string {
		switch (liveStatus.get(name)) {
			case "connected":
				return "bg-green-500/80";
			case "needs-auth":
				return "bg-amber-400/70";
			case "failed":
				return "bg-red-500/70";
			case "pending":
				return "bg-orange-500/60 animate-pulse";
			default:
				return "bg-primary/20";
		}
	}

	function typeBadge(cfg: VaultMcpConfig): string {
		if ("url" in cfg) return cfg.type === "sse" ? "SSE" : "HTTP";
		return "STDIO";
	}

	async function mutateMcp(
		next: Record<string, VaultMcpConfig>,
		apply: () => void,
		errLabel: string,
	) {
		try {
			await writeVaultMcpFn({ data: { servers: next } });
			apply();
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : `${errLabel} failed`);
		}
	}

	async function handleToggle(name: string, makeDisabled: boolean) {
		setOpError(null);
		try {
			await toggleVaultMcpFn({ data: { name, disabled: makeDisabled } });
			setServers(
				(prev) =>
					prev?.map((s) =>
						s.name === name ? { ...s, disabled: makeDisabled } : s,
					) ?? null,
			);
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Toggle failed");
		}
	}

	async function handleRemove(name: string) {
		if (!servers) return;
		setOpError(null);
		const next = Object.fromEntries(
			servers.filter((s) => s.name !== name).map((s) => [s.name, s.config]),
		);
		await mutateMcp(
			next,
			() => {
				setServers((prev) => prev?.filter((s) => s.name !== name) ?? null);
			},
			"Remove",
		);
	}

	async function handleSaveEdit(name: string, config: VaultMcpConfig) {
		if (!servers) return;
		setOpError(null);
		const next = Object.fromEntries(
			servers.map((s) => [s.name, s.name === name ? config : s.config]),
		);
		await mutateMcp(
			next,
			() => {
				setServers(
					(prev) =>
						prev?.map((s) => (s.name === name ? { ...s, config } : s)) ?? null,
				);
				setEditingServer(null);
			},
			"Save",
		);
	}

	async function handleAdd(name: string, config: VaultMcpConfig) {
		const current = servers ?? [];
		setOpError(null);
		if (current.some((s) => s.name === name)) {
			setOpError(`Server "${name}" already exists`);
			return;
		}
		const next = {
			...Object.fromEntries(current.map((s) => [s.name, s.config])),
			[name]: config,
		};
		await mutateMcp(
			next,
			() => {
				setServers([...current, { name, config, disabled: false }]);
				setShowAdd(false);
			},
			"Add",
		);
	}

	if (!vaultPath) return null;

	return (
		<Section title="MCP">
			{servers === null && (
				<div className="px-4 py-3 text-xs text-muted-foreground/50">
					loading…
				</div>
			)}

			{servers?.map((s) =>
				editingServer === s.name ? (
					<EditMcpServerForm
						key={s.name}
						serverName={s.name}
						initialForm={computeInitialForm(s)}
						opError={opError}
						onSave={(cfg) => handleSaveEdit(s.name, cfg)}
						onCancel={() => {
							setEditingServer(null);
							setOpError(null);
						}}
					/>
				) : (
					<div key={s.name} className="flex items-center gap-3 px-4 py-3">
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.name)}`}
						/>
						<span
							className={`flex-1 text-sm min-w-0 truncate ${s.disabled ? "text-muted-foreground line-through" : "text-foreground"}`}
						>
							{s.name}
						</span>
						<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
							{typeBadge(s.config)}
						</span>
						<button
							type="button"
							onClick={() => {
								setEditingServer(s.name);
								setOpError(null);
							}}
							className="text-[9px] tracking-widest text-muted-foreground/30 hover:text-foreground uppercase transition-colors shrink-0"
						>
							edit
						</button>
						<label className="flex items-center gap-1.5 cursor-pointer shrink-0">
							<input
								type="checkbox"
								checked={!s.disabled}
								onChange={() => handleToggle(s.name, !s.disabled)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{s.disabled ? "off" : "on"}
							</span>
						</label>
						<ConfirmAction
							label="remove?"
							onConfirm={() => void handleRemove(s.name)}
							className="shrink-0"
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="text-muted-foreground/30 hover:text-destructive transition-colors text-base shrink-0 leading-none"
								>
									×
								</button>
							)}
						/>
					</div>
				),
			)}

			{cloudServers.map((s) => (
				<div
					key={s.name}
					className="flex items-center gap-3 px-4 py-3 opacity-60"
				>
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.name)}`}
					/>
					<span className="flex-1 text-sm min-w-0 truncate text-foreground">
						{s.name.startsWith("claude.ai ")
							? s.name.slice("claude.ai ".length)
							: s.name}
					</span>
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
						claude.ai
					</span>
				</div>
			))}

			{servers !== null && !showAdd && !editingServer && (
				<div className="px-4 py-3">
					<button
						type="button"
						onClick={() => setShowAdd(true)}
						className="text-[10px] tracking-widest text-muted-foreground/40 hover:text-foreground transition-colors uppercase"
					>
						+ ADD SERVER
					</button>
				</div>
			)}

			{showAdd && (
				<AddMcpServerForm
					opError={opError}
					onAdd={handleAdd}
					onCancel={() => {
						setShowAdd(false);
						setOpError(null);
					}}
				/>
			)}

			{opError && !showAdd && !editingServer && (
				<div className="px-4 py-2 text-xs text-destructive">{opError}</div>
			)}

			<div className="px-4 py-3 flex items-center justify-between gap-4 border-t border-border">
				<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
					changes take effect on next session · cloud MCPs managed on claude.ai
					<br />
					use <span className="text-muted-foreground/50">check MCPs</span> to
					validate configs, runs a quick SDK query
				</div>
				<button
					type="button"
					disabled={probing}
					onClick={() => {
						setProbing(true);
						send({ type: "probe_mcp" });
					}}
					className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed uppercase transition-colors shrink-0"
				>
					{probing ? "checking…" : "check MCPs"}
				</button>
			</div>
		</Section>
	);
}

// ─── Agent MCP section ────────────────────────────────────────────────────────

/**
 * Standalone MCP server management for a cwd-mode Einherjar agent.
 * Reads/writes {agentPath}/.mcp.json directly.
 * Shown inside AgentCard on the Einherjar page.
 */
export function AgentMcpSection({ agentPath }: { agentPath: string }) {
	const [servers, setServers] = useState<VaultMcpServer[] | null>(null);
	const [liveStatus, setLiveStatus] = useState<Map<string, string>>(new Map());
	const [showAdd, setShowAdd] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [editingServer, setEditingServer] = useState<string | null>(null);

	// Only consume mcp_status messages tagged for this specific agent.
	const onMessage = useCallback(
		(msg: ServerMessage) => {
			if (msg.type === "mcp_status" && msg.agent_cwd === agentPath) {
				setLiveStatus(new Map(msg.servers.map((s) => [s.name, s.status])));
			}
		},
		[agentPath],
	);
	useWs(onMessage);

	useEffect(() => {
		getAgentMcpFn({ data: agentPath })
			.then((d) => setServers(d.servers))
			.catch((e) => {
				console.error("[agent-mcp] Failed to load servers:", e);
				setServers([]);
			});
		// Seed last-known status from shared cache.
		// Filter to project-scoped entries only — agent only surfaces .mcp.json servers.
		// (Cloud/global servers never appear in agent .mcp.json.)
		getLiveMcpStatusFn()
			.then((statuses) => {
				setLiveStatus(
					new Map(
						statuses
							.filter((s) => s.scope === "project")
							.map((s) => [s.name, s.status]),
					),
				);
			})
			.catch((e) => console.error("[agent-mcp] Failed to load status:", e));
	}, [agentPath]);

	function statusDot(name: string): string {
		switch (liveStatus.get(name)) {
			case "connected":
				return "bg-green-500/80";
			case "needs-auth":
				return "bg-amber-400/70";
			case "failed":
				return "bg-red-500/70";
			case "pending":
				return "bg-orange-500/60 animate-pulse";
			default:
				return "bg-primary/20";
		}
	}

	function typeBadge(cfg: VaultMcpConfig): string {
		if ("url" in cfg) return cfg.type === "sse" ? "SSE" : "HTTP";
		return "STDIO";
	}

	async function mutateMcp(
		next: Record<string, VaultMcpConfig>,
		apply: () => void,
		errLabel: string,
	) {
		try {
			await writeAgentMcpFn({ data: { agentPath, servers: next } });
			apply();
		} catch (e) {
			setOpError(e instanceof Error ? e.message : `${errLabel} failed`);
		}
	}

	async function handleToggle(name: string, makeDisabled: boolean) {
		setOpError(null);
		try {
			await toggleAgentMcpFn({
				data: { agentPath, name, disabled: makeDisabled },
			});
			setServers(
				(prev) =>
					prev?.map((s) =>
						s.name === name ? { ...s, disabled: makeDisabled } : s,
					) ?? null,
			);
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Toggle failed");
		}
	}

	async function handleRemove(name: string) {
		if (!servers) return;
		setOpError(null);
		const next = Object.fromEntries(
			servers.filter((s) => s.name !== name).map((s) => [s.name, s.config]),
		);
		await mutateMcp(
			next,
			() => setServers((prev) => prev?.filter((s) => s.name !== name) ?? null),
			"Remove",
		);
	}

	async function handleSaveEdit(name: string, config: VaultMcpConfig) {
		if (!servers) return;
		setOpError(null);
		const next = Object.fromEntries(
			servers.map((s) => [s.name, s.name === name ? config : s.config]),
		);
		await mutateMcp(
			next,
			() => {
				setServers(
					(prev) =>
						prev?.map((s) => (s.name === name ? { ...s, config } : s)) ?? null,
				);
				setEditingServer(null);
			},
			"Save",
		);
	}

	async function handleAdd(name: string, config: VaultMcpConfig) {
		const current = servers ?? [];
		setOpError(null);
		if (current.some((s) => s.name === name)) {
			setOpError(`Server "${name}" already exists`);
			return;
		}
		const next = {
			...Object.fromEntries(current.map((s) => [s.name, s.config])),
			[name]: config,
		};
		await mutateMcp(
			next,
			() => {
				setServers([...current, { name, config, disabled: false }]);
				setShowAdd(false);
			},
			"Add",
		);
	}

	return (
		<Section title="Agent MCP">
			{servers === null && (
				<div className="px-4 py-3 text-xs text-muted-foreground/50">
					loading…
				</div>
			)}

			{servers?.map((s) =>
				editingServer === s.name ? (
					<EditMcpServerForm
						key={s.name}
						serverName={s.name}
						initialForm={computeInitialForm(s)}
						opError={opError}
						onSave={(cfg) => handleSaveEdit(s.name, cfg)}
						onCancel={() => {
							setEditingServer(null);
							setOpError(null);
						}}
					/>
				) : (
					<div key={s.name} className="flex items-center gap-3 px-4 py-3">
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.name)}`}
						/>
						<span
							className={`flex-1 text-sm min-w-0 truncate ${
								s.disabled
									? "text-muted-foreground line-through"
									: "text-foreground"
							}`}
						>
							{s.name}
						</span>
						<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
							{typeBadge(s.config)}
						</span>
						<button
							type="button"
							onClick={() => {
								setEditingServer(s.name);
								setOpError(null);
							}}
							className="text-[9px] tracking-widest text-muted-foreground/30 hover:text-foreground uppercase transition-colors shrink-0"
						>
							edit
						</button>
						<label className="flex items-center gap-1.5 cursor-pointer shrink-0">
							<input
								type="checkbox"
								checked={!s.disabled}
								onChange={() => handleToggle(s.name, !s.disabled)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{s.disabled ? "off" : "on"}
							</span>
						</label>
						<ConfirmAction
							label="remove?"
							onConfirm={() => void handleRemove(s.name)}
							className="shrink-0"
							trigger={(open) => (
								<button
									type="button"
									onClick={open}
									className="text-muted-foreground/30 hover:text-destructive transition-colors text-base shrink-0 leading-none"
								>
									×
								</button>
							)}
						/>
					</div>
				),
			)}

			{servers !== null && !showAdd && !editingServer && (
				<div className="px-4 py-3">
					<button
						type="button"
						onClick={() => setShowAdd(true)}
						className="text-[10px] tracking-widest text-muted-foreground/40 hover:text-foreground transition-colors uppercase"
					>
						+ ADD SERVER
					</button>
				</div>
			)}

			{showAdd && (
				<AddMcpServerForm
					opError={opError}
					onAdd={handleAdd}
					onCancel={() => {
						setShowAdd(false);
						setOpError(null);
					}}
				/>
			)}

			{opError && !showAdd && !editingServer && (
				<div className="px-4 py-2 text-xs text-destructive">{opError}</div>
			)}

			<div className="px-4 py-3 border-t border-border">
				<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
					changes take effect on next session · stored in this agent's{" "}
					<span className="text-muted-foreground/50">.mcp.json</span>
					{" · "}status updates when agent session runs
				</div>
			</div>
		</Section>
	);
}
