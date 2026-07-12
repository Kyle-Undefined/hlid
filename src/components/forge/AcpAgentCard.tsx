import type { HlidConfig } from "#/config";
import type { AcpAuthMethod, AcpCatalogItem } from "#/lib/serverFns/acp";
import { AcpAuthMethodRow } from "./AcpAuthMethodRow";

export type AcpAgentConfig = NonNullable<HlidConfig["acp_agents"]>[number];

/** One catalog entry: enable toggle, command/install guidance, config overrides, and auth methods. */
export function AcpAgentCard({
	item,
	configured,
	busy,
	authMethods,
	onToggle,
	onUpdateOverride,
	onInspect,
}: {
	item: AcpCatalogItem;
	configured: AcpAgentConfig | undefined;
	busy: boolean;
	authMethods: AcpAuthMethod[] | undefined;
	onToggle: () => void;
	onUpdateOverride: (patch: Partial<AcpAgentConfig>) => void;
	onInspect: (methodId?: string) => void;
}) {
	const enabled = Boolean(configured);
	return (
		<div className="px-4 py-3 space-y-2">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="text-sm">
						{item.name}{" "}
						<span className="text-[9px] text-muted-foreground">
							{item.version}
						</span>
					</div>
					<p className="text-xs text-muted-foreground">{item.description}</p>
				</div>
				<button
					type="button"
					onClick={onToggle}
					className="px-2 py-1 border border-border text-[10px] uppercase"
				>
					{enabled ? "Disable" : "Enable"}
				</button>
			</div>
			<div className="text-[10px] font-mono text-muted-foreground break-all">
				{item.available
					? `${item.command} ${item.args.join(" ")} · ready`
					: item.installGuidance}
			</div>
			{configured && (
				<div className="grid sm:grid-cols-2 gap-2">
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Executable override
						<input
							value={configured.executable ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									executable: event.target.value || undefined,
								})
							}
							placeholder={item.command || "full command path"}
							className="mt-1 w-full bg-secondary border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
					<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Arguments override
						<input
							value={configured.args?.join(" ") ?? ""}
							onChange={(event) =>
								onUpdateOverride({
									args: event.target.value.trim()
										? event.target.value.trim().split(/\s+/)
										: undefined,
								})
							}
							placeholder={item.args.join(" ")}
							className="mt-1 w-full bg-secondary border border-border px-2 py-1 text-xs font-mono normal-case"
						/>
					</label>
				</div>
			)}
			{enabled && item.available && (
				<button
					type="button"
					disabled={busy}
					onClick={() => onInspect()}
					className="text-[10px] text-primary uppercase"
				>
					{busy ? "Checking…" : "Authentication options"}
				</button>
			)}
			{authMethods?.map((method) => (
				<AcpAuthMethodRow
					key={method.id}
					method={method}
					item={item}
					onAuthenticate={(methodId) => onInspect(methodId)}
				/>
			))}
		</div>
	);
}
