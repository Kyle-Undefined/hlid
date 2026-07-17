import { Field, FilePathField, StatusIndicator, TextInput } from "./fields";
import type { ServerForm } from "./NetworkSection";

export type TailscaleStatus = {
	installed: boolean;
	state:
		| "Running"
		| "NeedsLogin"
		| "Stopped"
		| "Starting"
		| "NoState"
		| "Unknown"
		| null;
	magicDNS: string | null;
	ips: string[];
	error?: string;
};

function availabilityLabel(value: boolean | null): string {
	if (value === null) return "checking…";
	return value ? "yes" : "not detected";
}

function authenticationLabel(value: boolean | null): string {
	if (value === null) return "?";
	return value ? "yes" : "no";
}

function authenticationHint(status: TailscaleStatus | null) {
	if (status?.state === "NeedsLogin") return "run `tailscale up` to log in";
	if (status?.state && status.state !== "Running")
		return `state: ${status.state}`;
	return undefined;
}

function tailscaleUrl(status: TailscaleStatus | null, server: ServerForm) {
	if (status?.state !== "Running" || !status.magicDNS) return null;
	if (!server.tlsCertPath || !server.tlsKeyPath || !server.localNetworkAccess)
		return null;
	return `https://${status.magicDNS}:${Number(server.tlsProxyPort) || 3443}`;
}

/** Tailscale install/auth status, MagicDNS reachability, TLS cert config, and guided setup entry point. */
export function TailscaleFields({
	server,
	onChange,
	status,
	checking,
	onRefresh,
	onStartSetup,
}: {
	server: ServerForm;
	onChange: (patch: Partial<ServerForm>) => void;
	status: TailscaleStatus | null;
	checking: boolean;
	onRefresh: () => void;
	onStartSetup: () => void;
}) {
	const installed = status?.installed ?? null;
	const authenticated = status ? status.state === "Running" : null;
	const url = tailscaleUrl(status, server);

	return (
		<>
			<div className="px-4 py-2 text-[9px] tracking-widest text-muted-foreground/60 uppercase">
				Tailscale
			</div>
			<Field label="Installed">
				<div className="flex items-center gap-3">
					<StatusIndicator ok={installed}>
						{availabilityLabel(installed)}
					</StatusIndicator>
					{installed === false && (
						<button
							type="button"
							onClick={() =>
								window.open(
									"https://tailscale.com/download",
									"_blank",
									"noopener,noreferrer",
								)
							}
							className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
						>
							DOWNLOAD
						</button>
					)}
					<button
						type="button"
						onClick={onRefresh}
						disabled={checking}
						className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase disabled:opacity-40"
					>
						{checking ? "…" : "RECHECK"}
					</button>
				</div>
			</Field>
			{installed && (
				<Field label="Authenticated" hint={authenticationHint(status)}>
					<StatusIndicator ok={authenticated}>
						{authenticationLabel(authenticated)}
					</StatusIndicator>
				</Field>
			)}
			{status?.magicDNS && (
				<div className="px-4 py-3 space-y-1.5">
					<div className="text-sm text-foreground">MagicDNS</div>
					<div className="text-xs font-mono text-muted-foreground break-all">
						{status.magicDNS}
					</div>
				</div>
			)}
			<Field label="TLS Cert Path">
				<FilePathField
					value={server.tlsCertPath}
					onChange={(v) => onChange({ tlsCertPath: v })}
					placeholder="/path/to/cert.pem"
					extensions={[".pem", ".crt", ".cer"]}
					external
				/>
			</Field>
			<Field label="TLS Key Path">
				<FilePathField
					value={server.tlsKeyPath}
					onChange={(v) => onChange({ tlsKeyPath: v })}
					placeholder="/path/to/key.pem"
					extensions={[".pem", ".key"]}
					external
				/>
			</Field>
			<Field label="TLS Proxy Port">
				<TextInput
					value={server.tlsProxyPort}
					onChange={(v) => onChange({ tlsProxyPort: v })}
					placeholder="3443"
					mono
				/>
			</Field>
			{url && (
				<div className="px-4 py-3 space-y-1.5">
					<div className="text-sm text-foreground">Reachable at</div>
					<div className="text-xs text-muted-foreground">
						open this URL from any device on your tailnet
					</div>
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="block text-xs font-mono text-primary hover:underline break-all pt-1"
					>
						{url}
					</a>
				</div>
			)}
			<Field
				label="Setup Guide"
				hint="opens a new chat with a guided setup prompt for install, auth, and cert generation"
			>
				<button
					type="button"
					onClick={onStartSetup}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
				>
					START
				</button>
			</Field>
			{status?.error && (
				<div className="px-4 py-2 text-xs text-destructive/80">
					{status.error}
				</div>
			)}
		</>
	);
}
