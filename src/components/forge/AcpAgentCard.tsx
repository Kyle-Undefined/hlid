import type { HlidConfig } from "#/config";
import type {
	AcpAgentInfo,
	AcpAuthMethod,
	AcpCatalogItem,
} from "#/lib/serverFns/acp";
import { AcpAuthMethodRow } from "./AcpAuthMethodRow";

export type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];
type AcpCardOperation = "inspect" | "refresh" | null;

function invocationLabel(item: AcpCatalogItem): string {
	return [item.command, ...item.args].filter(Boolean).join(" ");
}

/** One catalog entry: enable toggle, command/install guidance, config overrides, and auth methods. */
export function AcpAgentCard({
	item,
	configured,
	operation,
	disabled,
	authMethods,
	agentInfo,
	optionsRefreshed,
	configurationCurrent,
	onToggle,
	onUpdateOverride,
	onInspect,
	onRefreshOptions,
}: {
	item: AcpCatalogItem;
	configured: AcpAgentConfig | undefined;
	operation: AcpCardOperation;
	disabled: boolean;
	authMethods: AcpAuthMethod[] | undefined;
	agentInfo: AcpAgentInfo | null | undefined;
	optionsRefreshed: boolean;
	configurationCurrent: boolean;
	onToggle: () => void;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
	onInspect: (methodId?: string) => void;
	onRefreshOptions: () => void;
}) {
	const enabled = Boolean(configured);
	const openCode = item.id === "opencode";
	const invocation = invocationLabel(item);
	return (
		<div className="min-w-0 space-y-3 px-4 py-3">
			{openCode && (
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-[9px] tracking-widest uppercase">
					<span className="border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">
						Featured integration
					</span>
					<span className="text-muted-foreground">OpenCode over ACP</span>
				</div>
			)}
			<div className="flex min-w-0 flex-col items-start gap-3 @2xl:flex-row @2xl:justify-between">
				<div className="min-w-0">
					<div className="break-words text-sm">
						{item.name}{" "}
						<span className="text-[9px] text-muted-foreground">
							{openCode ? "ACP registry" : "catalog"} {item.version}
						</span>
					</div>
					<p className="break-words text-xs text-muted-foreground">
						{openCode
							? "Use OpenCode in Raven through its supported Agent Client Protocol connection."
							: item.description}
					</p>
				</div>
				<button
					type="button"
					disabled={disabled}
					onClick={onToggle}
					className="shrink-0 border border-border px-2 py-1 text-[10px] uppercase"
				>
					{enabled ? "Disable" : "Enable"}
				</button>
			</div>
			{openCode ? (
				<div
					className={`min-w-0 space-y-2 border px-3 py-2 text-xs ${
						item.available
							? "border-status-success/30 bg-status-success/5"
							: "border-status-warning/30 bg-status-warning/5"
					}`}
				>
					<div
						className={
							item.available ? "text-status-success" : "text-status-warning"
						}
					>
						{item.available
							? enabled
								? agentInfo
									? "OpenCode ACP initialized"
									: "OpenCode CLI found · verify the ACP connection"
								: "OpenCode CLI found · enable it to use Raven"
							: "OpenCode CLI not found"}
					</div>
					{item.available ? (
						<div className="min-w-0 space-y-1 text-[10px] text-muted-foreground">
							<div>
								<span className="uppercase tracking-widest">Resolved CLI</span>{" "}
								<code className="break-all text-foreground/80">
									{item.resolvedExecutable ?? item.command}
								</code>
							</div>
							<div>
								<span className="uppercase tracking-widest">ACP command</span>{" "}
								<code className="break-all text-foreground/80">
									{invocation}
								</code>
							</div>
							<p>
								OpenCode Desktop is optional here; Hlid connects directly to
								this CLI.
							</p>
						</div>
					) : (
						<div className="space-y-1 text-[10px] text-muted-foreground">
							<p>
								OpenCode Desktop and the OpenCode CLI are separate installs.
								Hlid needs the CLI in the same environment where Hlid runs.
							</p>
							<p className="break-words text-status-warning/90">
								{item.unavailableReason ?? item.installGuidance}
							</p>
							<p>{item.installGuidance}</p>
						</div>
					)}
				</div>
			) : (
				<div className="min-w-0 space-y-0.5 break-all font-mono text-[10px] text-muted-foreground">
					<div>
						{item.available
							? `${invocation} · path found`
							: item.installGuidance}
					</div>
					{item.available && item.resolvedExecutable && (
						<div>resolved {item.resolvedExecutable}</div>
					)}
				</div>
			)}
			{agentInfo && (
				<div className="break-all font-mono text-[10px] text-status-success/80">
					{openCode ? "installed" : "initialized"} {agentInfo.name}{" "}
					{agentInfo.version}
				</div>
			)}
			{openCode && (
				<div className="grid min-w-0 gap-2 text-[10px] text-muted-foreground @2xl:grid-cols-2">
					<div className="border border-border/70 px-3 py-2">
						<div className="mb-1 tracking-widest text-foreground/70 uppercase">
							Available through ACP
						</div>
						Raven chat, OpenCode tools, approval requests, project instructions,
						modes, and OpenCode-configured MCP servers.
					</div>
					<div className="border border-border/70 px-3 py-2">
						<div className="mb-1 tracking-widest text-foreground/70 uppercase">
							Connection boundary
						</div>
						Desktop session management and message-level undo or redo are not
						exposed by this ACP connection.
					</div>
					<p className="@2xl:col-span-2">
						Models, modes, and effort controls come from the current OpenCode
						workspace. Hlid does not invent controls or infer account-level
						hidden models.
					</p>
				</div>
			)}
			{configured && (
				<div className="grid sm:grid-cols-2 gap-2">
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Executable override
						<input
							disabled={disabled}
							value={configured.executable ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									executable: event.target.value || undefined,
								})
							}
							placeholder={item.command || "full command path"}
							className="mt-1 w-full bg-input border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Arguments override
						<input
							disabled={disabled}
							value={configured.args?.join(" ") ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									args: event.target.value.trim()
										? event.target.value.trim().split(/\s+/)
										: undefined,
								})
							}
							placeholder={item.args.join(" ")}
							className="mt-1 w-full bg-input border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
				</div>
			)}
			{enabled && item.available && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<button
						type="button"
						disabled={disabled || !configurationCurrent}
						onClick={() => onInspect()}
						className="text-[10px] text-primary uppercase"
					>
						{!configurationCurrent
							? "Waiting for saved configuration…"
							: operation === "inspect"
								? openCode
									? "Verifying…"
									: "Checking…"
								: openCode
									? "Verify OpenCode ACP"
									: "Inspect agent"}
					</button>
					<button
						type="button"
						disabled={disabled || !configurationCurrent}
						onClick={onRefreshOptions}
						className="text-[10px] text-primary uppercase"
					>
						{!configurationCurrent
							? "Waiting for saved configuration…"
							: operation === "refresh"
								? "Refreshing…"
								: openCode
									? "Refresh models & modes"
									: "Refresh options"}
					</button>
					{optionsRefreshed && (
						<span
							className="text-[10px] text-status-success/80"
							aria-live="polite"
						>
							{openCode
								? "Models and modes refreshed for this workspace."
								: "Options refreshed for this workspace."}
						</span>
					)}
				</div>
			)}
			{authMethods && authMethods.length > 0 && (
				<div className="min-w-0 space-y-2">
					<div className="space-y-1 text-xs text-muted-foreground">
						<div className="text-[9px] tracking-widest uppercase">
							Credential management
						</div>
						<p>
							{openCode
								? "OpenCode advertises these credential actions; it does not mean you are signed out. Use them only to add or replace credentials."
								: "These are login methods advertised by the agent, not a sign-in status. If the agent is already signed in, no action is needed."}
						</p>
					</div>
					{authMethods.map((method) => (
						<AcpAuthMethodRow
							key={method.id}
							method={method}
							item={item}
							disabled={disabled}
							onAuthenticate={(methodId) => onInspect(methodId)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
