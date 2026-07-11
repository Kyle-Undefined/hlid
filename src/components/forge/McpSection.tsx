import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { useWs } from "#/hooks/useWs";
import type { ServerMessage } from "#/server/protocol";
import { Section } from "./fields";
import type { VaultMcpConfig, VaultMcpServer } from "./McpServerForm";
import {
	AddMcpServerForm,
	computeInitialForm,
	EditMcpServerForm,
} from "./McpServerForm";
import {
	getAgentMcpFn,
	getLiveMcpStatusFn,
	getVaultMcpFn,
	toggleAgentMcpFn,
	toggleVaultMcpFn,
	writeAgentMcpFn,
	writeVaultMcpFn,
} from "./mcpServerFns";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function statusDot(liveStatus: Map<string, string>, name: string): string {
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

// ─── McpServerManager ─────────────────────────────────────────────────────────

export interface McpServerManagerProps {
	title: string;
	/** null = vault scope; string = agent cwd to filter mcp_status messages */
	agentCwd: string | null;
	loadServers: () => Promise<{ servers: VaultMcpServer[] }>;
	writeServers: (servers: Record<string, VaultMcpConfig>) => Promise<void>;
	toggleServer: (name: string, disabled: boolean) => Promise<void>;
	loadLiveStatus: () => Promise<
		Array<{ name: string; status: string; scope?: string }>
	>;
	/** Show claude.ai-managed cloud servers (vault only) */
	showCloudServers?: boolean;
	/** Show "check MCPs" probe button (vault only) */
	showProbe?: boolean;
	/** Send sync_mcp_list after write (vault only) */
	syncAfterWrite?: boolean;
	/** Custom footer node */
	footer?: ReactNode;
}

export function McpServerManager({
	title,
	agentCwd,
	loadServers,
	writeServers,
	toggleServer,
	loadLiveStatus,
	showCloudServers = false,
	showProbe = false,
	syncAfterWrite = false,
	footer,
}: McpServerManagerProps) {
	const [servers, setServers] = useState<VaultMcpServer[] | null>(null);
	const [liveStatus, setLiveStatus] = useState<Map<string, string>>(new Map());
	const [cloudServers, setCloudServers] = useState<
		Array<{ name: string; status: string }>
	>([]);
	const [showAdd, setShowAdd] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [editingServer, setEditingServer] = useState<string | null>(null);
	const [probing, setProbing] = useState(false);

	const onMessage = useCallback(
		(msg: ServerMessage) => {
			if (msg.type !== "mcp_status") return;
			// Vault: consume global status (no agent_cwd). Agent: only consume own cwd.
			const isOurs =
				agentCwd === null ? !msg.agent_cwd : msg.agent_cwd === agentCwd;
			if (!isOurs) return;

			setLiveStatus(new Map(msg.servers.map((s) => [s.name, s.status])));
			if (agentCwd === null) {
				// Vault — also update cloud servers
				setCloudServers(
					msg.servers
						.filter((s) => s.scope === "claudeai")
						.map((s) => ({ name: s.name, status: s.status })),
				);
				setProbing(false);
			}
		},
		[agentCwd],
	);
	const { send } = useWs(onMessage);

	useEffect(() => {
		loadServers()
			.then((d) => setServers(d.servers))
			.catch((e) => {
				console.error("[mcp] Failed to load servers:", e);
				setServers([]);
			});
		loadLiveStatus()
			.then((statuses) => {
				// Agent scope: seed only project-scoped entries
				const filtered =
					agentCwd !== null
						? statuses.filter((s) => s.scope === "project")
						: statuses;
				setLiveStatus(new Map(filtered.map((s) => [s.name, s.status])));
				if (agentCwd === null) {
					setCloudServers(
						statuses
							.filter((s) => s.scope === "claudeai")
							.map((s) => ({ name: s.name, status: s.status })),
					);
				}
			})
			.catch((e) => console.error("[mcp] Failed to load status:", e));
	}, [agentCwd, loadServers, loadLiveStatus]);

	async function mutateMcp(
		next: Record<string, VaultMcpConfig>,
		apply: () => void,
		errLabel: string,
	) {
		try {
			await writeServers(next);
			apply();
			if (syncAfterWrite) send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : `${errLabel} failed`);
		}
	}

	async function handleToggle(name: string, makeDisabled: boolean) {
		setOpError(null);
		try {
			await toggleServer(name, makeDisabled);
			setServers(
				(prev) =>
					prev?.map((s) =>
						s.name === name ? { ...s, disabled: makeDisabled } : s,
					) ?? null,
			);
			if (syncAfterWrite) send({ type: "sync_mcp_list" });
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

	return (
		<Section title={title}>
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
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(liveStatus, s.name)}`}
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

			{showCloudServers &&
				cloudServers.map((s) => (
					<div
						key={s.name}
						className="flex items-center gap-3 px-4 py-3 opacity-60"
					>
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(liveStatus, s.name)}`}
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

			{footer ?? (
				<div className="px-4 py-3 flex items-center justify-between gap-4 border-t border-border">
					<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
						changes take effect on next session · cloud MCPs managed on
						claude.ai
						<br />
						use <span className="text-muted-foreground/50">check MCPs</span> to
						validate configs, runs a quick SDK query
					</div>
					{showProbe && (
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
					)}
				</div>
			)}
		</Section>
	);
}

// ─── Public wrappers ──────────────────────────────────────────────────────────

export function McpSection({ vaultPath }: { vaultPath: string }) {
	if (!vaultPath) return null;
	return (
		<McpServerManager
			title="MCP"
			agentCwd={null}
			loadServers={getVaultMcpFn}
			writeServers={(servers) => writeVaultMcpFn({ data: { servers } })}
			toggleServer={(name, disabled) =>
				toggleVaultMcpFn({ data: { name, disabled } })
			}
			loadLiveStatus={getLiveMcpStatusFn}
			showCloudServers
			showProbe
			syncAfterWrite
		/>
	);
}

/**
 * Standalone MCP server management for a cwd-mode Einherjar agent.
 * Reads/writes {agentPath}/.mcp.json directly.
 * Shown inside AgentCard on the Einherjar page.
 */
export function AgentMcpSection({ agentPath }: { agentPath: string }) {
	return (
		<McpServerManager
			title="Agent MCP"
			agentCwd={agentPath}
			loadServers={() => getAgentMcpFn({ data: agentPath })}
			writeServers={(servers) =>
				writeAgentMcpFn({ data: { agentPath, servers } })
			}
			toggleServer={(name, disabled) =>
				toggleAgentMcpFn({ data: { agentPath, name, disabled } })
			}
			loadLiveStatus={getLiveMcpStatusFn}
			footer={
				<div className="px-4 py-3 border-t border-border">
					<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
						changes take effect on next session · stored in this agent's{" "}
						<span className="text-muted-foreground/50">.mcp.json</span>
						{" · "}status updates when agent session runs
					</div>
				</div>
			}
		/>
	);
}
