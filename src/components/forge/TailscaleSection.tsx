import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { StatusDot } from "#/components/McpStatusDot";
import { Field, FilePathField, Section, TextInput } from "./fields";

type TailscaleStatus = {
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

function tailscaleSetupPrompt(cwd: string) {
	return `Help me set up Tailscale for hlid. My current working directory is \`${cwd}\`. Detect if Tailscale is installed and walk me through install for my OS if not. Then help me run \`tailscale up\` to authenticate. Ask me where to store the TLS certs, then run \`tailscale cert <my-magicdns-hostname>\` there. Update tls_cert_path and tls_key_path in hlid.config.toml. When done, tell me to restart hlid.`;
}

export function TailscaleSection({
	tlsProxyPort,
	setTlsProxyPort,
	tlsCertPath,
	setTlsCertPath,
	tlsKeyPath,
	setTlsKeyPath,
	localNetworkAccess,
	cwd,
}: {
	tlsProxyPort: string;
	setTlsProxyPort: (v: string) => void;
	tlsCertPath: string;
	setTlsCertPath: (v: string) => void;
	tlsKeyPath: string;
	setTlsKeyPath: (v: string) => void;
	localNetworkAccess: boolean;
	cwd: string;
}) {
	const router = useRouter();
	const [status, setStatus] = useState<TailscaleStatus | null>(null);
	const [checking, setChecking] = useState(false);

	const refresh = useCallback(async () => {
		setChecking(true);
		try {
			const res = await fetch("/api/tailscale");
			if (res.ok) {
				setStatus((await res.json()) as TailscaleStatus);
			} else {
				console.error("[tailscale] Status fetch returned", res.status);
			}
		} catch (e) {
			console.error("[tailscale] Failed to fetch status:", e);
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const installed = status?.installed ?? null;
	const authed = status?.state === "Running" ? true : status ? false : null;
	const certsConfigured = Boolean(tlsCertPath && tlsKeyPath);
	const reachable =
		status?.state === "Running" &&
		status.magicDNS &&
		certsConfigured &&
		localNetworkAccess;
	const url = reachable
		? `https://${status.magicDNS}:${Number(tlsProxyPort) || 3443}`
		: null;

	function startSetup() {
		router.navigate({
			to: "/raven",
			search: { prompt: tailscaleSetupPrompt(cwd) },
		});
	}

	return (
		<Section title="Tailscale">
			<Field label="Installed">
				<div className="flex items-center gap-3">
					<StatusDot ok={installed} />
					<span className="text-xs text-muted-foreground">
						{installed === null
							? "checking…"
							: installed
								? "yes"
								: "not detected"}
					</span>
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
						onClick={() => void refresh()}
						disabled={checking}
						className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase disabled:opacity-40"
					>
						{checking ? "…" : "RECHECK"}
					</button>
				</div>
			</Field>
			{installed && (
				<Field
					label="Authenticated"
					hint={
						status?.state === "NeedsLogin"
							? "run `tailscale up` to log in"
							: status?.state && status.state !== "Running"
								? `state: ${status.state}`
								: undefined
					}
				>
					<div className="flex items-center gap-3">
						<StatusDot ok={authed} />
						<span className="text-xs text-muted-foreground">
							{authed === null ? "?" : authed ? "yes" : "no"}
						</span>
					</div>
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
					value={tlsCertPath}
					onChange={setTlsCertPath}
					placeholder="/path/to/cert.pem"
					extensions={[".pem", ".crt", ".cer"]}
					external
				/>
			</Field>
			<Field label="TLS Key Path">
				<FilePathField
					value={tlsKeyPath}
					onChange={setTlsKeyPath}
					placeholder="/path/to/key.pem"
					extensions={[".pem", ".key"]}
					external
				/>
			</Field>
			<Field label="TLS Proxy Port">
				<TextInput
					value={tlsProxyPort}
					onChange={setTlsProxyPort}
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
				label="Set up with Claude"
				hint="opens chat with a setup prompt, Claude walks you through install, auth, and cert generation"
			>
				<button
					type="button"
					onClick={startSetup}
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
		</Section>
	);
}
