import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";
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

type CloudServer = { name: string; status: string; providerId?: string };

/** Live per-server status via mcp_status WS messages, scoped to vault or one agent cwd. */
function useMcpLiveStatus(agentCwd: string | null) {
	const [liveStatus, setLiveStatus] = useState<Map<string, string>>(new Map());
	const [cloudServers, setCloudServers] = useState<CloudServer[]>([]);
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
						.map((s) => ({
							name: s.name,
							status: s.status,
							providerId: msg.provider_id,
						})),
				);
				setProbing(false);
			}
		},
		[agentCwd],
	);
	const { send } = useWs(onMessage);

	return {
		liveStatus,
		setLiveStatus,
		cloudServers,
		setCloudServers,
		probing,
		setProbing,
		send,
	};
}

type McpLiveStatus = ReturnType<typeof useMcpLiveStatus>;

function useMcpInitialLoad(
	props: McpServerManagerProps,
	setServers: Dispatch<SetStateAction<VaultMcpServer[] | null>>,
	status: McpLiveStatus,
) {
	const { agentCwd, loadServers, loadLiveStatus } = props;
	const { setLiveStatus, setCloudServers } = status;
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
	}, [
		agentCwd,
		loadServers,
		loadLiveStatus,
		setServers,
		setLiveStatus,
		setCloudServers,
	]);
}

/** Everything a mutation needs to write config and reflect the result locally. */
type McpMutationCtx = {
	servers: VaultMcpServer[] | null;
	setServers: Dispatch<SetStateAction<VaultMcpServer[] | null>>;
	setOpError: (e: string | null) => void;
	setShowAdd: (v: boolean) => void;
	setEditingServer: (v: string | null) => void;
	writeServers: McpServerManagerProps["writeServers"];
	toggleServer: McpServerManagerProps["toggleServer"];
	syncAfterWrite: boolean;
	agentCwd: string | null;
	send: McpLiveStatus["send"];
};

function syncConfiguredServers(ctx: McpMutationCtx): void {
	if (!ctx.syncAfterWrite) return;
	ctx.send({
		type: "sync_mcp_list",
		...(ctx.agentCwd ? { agent_cwd: ctx.agentCwd } : {}),
	});
}

async function mutateMcp(
	ctx: McpMutationCtx,
	next: Record<string, VaultMcpConfig>,
	apply: () => void,
	errLabel: string,
) {
	try {
		await ctx.writeServers(next);
		apply();
		syncConfiguredServers(ctx);
	} catch (e) {
		ctx.setOpError(e instanceof Error ? e.message : `${errLabel} failed`);
	}
}

async function toggleMcpServer(
	ctx: McpMutationCtx,
	name: string,
	makeDisabled: boolean,
) {
	ctx.setOpError(null);
	try {
		await ctx.toggleServer(name, makeDisabled);
		ctx.setServers(
			(prev) =>
				prev?.map((s) =>
					s.name === name ? { ...s, disabled: makeDisabled } : s,
				) ?? null,
		);
		syncConfiguredServers(ctx);
	} catch (e) {
		ctx.setOpError(e instanceof Error ? e.message : "Toggle failed");
	}
}

async function removeMcpServer(ctx: McpMutationCtx, name: string) {
	if (!ctx.servers) return;
	ctx.setOpError(null);
	const next = Object.fromEntries(
		ctx.servers.filter((s) => s.name !== name).map((s) => [s.name, s.config]),
	);
	await mutateMcp(
		ctx,
		next,
		() => {
			ctx.setServers((prev) => prev?.filter((s) => s.name !== name) ?? null);
		},
		"Remove",
	);
}

async function saveMcpServerEdit(
	ctx: McpMutationCtx,
	name: string,
	config: VaultMcpConfig,
) {
	if (!ctx.servers) return;
	ctx.setOpError(null);
	const next = Object.fromEntries(
		ctx.servers.map((s) => [s.name, s.name === name ? config : s.config]),
	);
	await mutateMcp(
		ctx,
		next,
		() => {
			ctx.setServers(
				(prev) =>
					prev?.map((s) => (s.name === name ? { ...s, config } : s)) ?? null,
			);
			ctx.setEditingServer(null);
		},
		"Save",
	);
}

async function addMcpServer(
	ctx: McpMutationCtx,
	name: string,
	config: VaultMcpConfig,
) {
	const current = ctx.servers ?? [];
	ctx.setOpError(null);
	if (current.some((s) => s.name === name)) {
		ctx.setOpError(`Server "${name}" already exists`);
		return;
	}
	const next = {
		...Object.fromEntries(current.map((s) => [s.name, s.config])),
		[name]: config,
	};
	await mutateMcp(
		ctx,
		next,
		() => {
			ctx.setServers([...current, { name, config, disabled: false }]);
			ctx.setShowAdd(false);
		},
		"Add",
	);
}

function McpServerRow({
	server,
	liveStatus,
	onEdit,
	onToggle,
	onRemove,
}: {
	server: VaultMcpServer;
	liveStatus: Map<string, string>;
	onEdit: () => void;
	onToggle: () => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex items-center gap-3 px-4 py-3">
			<span
				className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(liveStatus, server.name)}`}
			/>
			<span
				className={`flex-1 text-sm min-w-0 truncate ${server.disabled ? "text-muted-foreground line-through" : "text-foreground"}`}
			>
				{server.name}
			</span>
			<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
				{typeBadge(server.config)}
			</span>
			<button
				type="button"
				onClick={onEdit}
				className="text-[9px] tracking-widest text-muted-foreground/30 hover:text-foreground uppercase transition-colors shrink-0"
			>
				edit
			</button>
			<label className="flex items-center gap-1.5 cursor-pointer shrink-0">
				<input
					type="checkbox"
					checked={!server.disabled}
					onChange={onToggle}
					className="accent-primary w-3.5 h-3.5"
				/>
				<span className="text-xs text-muted-foreground">
					{server.disabled ? "off" : "on"}
				</span>
			</label>
			<ConfirmAction
				label="remove?"
				onConfirm={onRemove}
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
	);
}

function CloudServerRows({
	cloudServers,
	liveStatus,
}: {
	cloudServers: CloudServer[];
	liveStatus: Map<string, string>;
}) {
	return (
		<>
			{cloudServers.map((s) => (
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
						{s.providerId ?? "provider"}
					</span>
				</div>
			))}
		</>
	);
}

function ManagerFooter({
	showProbe,
	status,
}: {
	showProbe: boolean;
	status: McpLiveStatus;
}) {
	const { probing, setProbing, send } = status;
	return (
		<div className="px-4 py-3 flex items-center justify-between gap-4 border-t border-border">
			<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
				compatibility config: .mcp.json · provider-native servers are discovered
				at runtime
				<br />
				use <span className="text-muted-foreground/50">check MCPs</span> to
				refresh the active provider without starting an assistant turn
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
	);
}

export function McpServerManager(props: McpServerManagerProps) {
	const { title, showCloudServers = false, showProbe = false, footer } = props;
	const [servers, setServers] = useState<VaultMcpServer[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [opError, setOpError] = useState<string | null>(null);
	const [editingServer, setEditingServer] = useState<string | null>(null);
	const status = useMcpLiveStatus(props.agentCwd);
	useMcpInitialLoad(props, setServers, status);

	const ctx: McpMutationCtx = {
		servers,
		setServers,
		setOpError,
		setShowAdd,
		setEditingServer,
		writeServers: props.writeServers,
		toggleServer: props.toggleServer,
		syncAfterWrite: props.syncAfterWrite ?? false,
		agentCwd: props.agentCwd,
		send: status.send,
	};

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
						onSave={(cfg) => saveMcpServerEdit(ctx, s.name, cfg)}
						onCancel={() => {
							setEditingServer(null);
							setOpError(null);
						}}
					/>
				) : (
					<McpServerRow
						key={s.name}
						server={s}
						liveStatus={status.liveStatus}
						onEdit={() => {
							setEditingServer(s.name);
							setOpError(null);
						}}
						onToggle={() => void toggleMcpServer(ctx, s.name, !s.disabled)}
						onRemove={() => void removeMcpServer(ctx, s.name)}
					/>
				),
			)}

			{showCloudServers && (
				<CloudServerRows
					cloudServers={status.cloudServers}
					liveStatus={status.liveStatus}
				/>
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
					onAdd={(name, config) => addMcpServer(ctx, name, config)}
					onCancel={() => {
						setShowAdd(false);
						setOpError(null);
					}}
				/>
			)}

			{opError && !showAdd && !editingServer && (
				<div className="px-4 py-2 text-xs text-destructive">{opError}</div>
			)}

			{footer ?? <ManagerFooter showProbe={showProbe} status={status} />}
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
			syncAfterWrite
			footer={
				<div className="px-4 py-3 border-t border-border">
					<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
						compatibility config for providers that read{" "}
						<span className="text-muted-foreground/50">.mcp.json</span>
						{" · "}provider-native status updates when this agent runs
					</div>
				</div>
			}
		/>
	);
}
