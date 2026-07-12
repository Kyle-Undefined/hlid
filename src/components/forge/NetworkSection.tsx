import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { uid } from "#/lib/utils";
import { Field, Section, TextInput } from "./fields";
import { TailscaleFields, type TailscaleStatus } from "./TailscaleFields";

export type ServerForm = {
	port: string;
	tlsCertPath: string;
	tlsKeyPath: string;
	tlsProxyPort: string;
	localNetworkAccess: boolean;
	allowExternalAgents: boolean;
};

function tailscaleSetupPrompt(cwd: string) {
	return `Help me set up Tailscale for hlid. My current working directory is \`${cwd}\`. Detect if Tailscale is installed and walk me through install for my OS if not. Then help me run \`tailscale up\` to authenticate. Store the TLS certs in the OS user data directory: on Windows use \`%LOCALAPPDATA%\\hlid\\\` (AppData\\Local — not ProgramData). Run \`tailscale cert <my-magicdns-hostname>\` there. Update tls_cert_path and tls_key_path in hlid.config.toml. When done, tell me to restart hlid.`;
}

export function NetworkSection({
	server,
	onChange,
	cwd,
}: {
	server: ServerForm;
	onChange: (patch: Partial<ServerForm>) => void;
	cwd: string;
}) {
	const navigate = useNavigate();
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

	function startSetup() {
		void navigate({
			to: "/raven",
			search: { session: uid(), prompt: tailscaleSetupPrompt(cwd) },
		});
	}

	return (
		<Section title="Network">
			<Field label="Port">
				<TextInput
					value={server.port}
					onChange={(v) => onChange({ port: v })}
					placeholder="3000"
					mono
				/>
			</Field>
			<Field
				label="Local Network Access"
				hint="binds the server on 0.0.0.0 so devices on your LAN/Tailscale can connect (default binds 127.0.0.1 only). requires restart. anyone on the network can reach the server when on."
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={server.localNetworkAccess}
						onChange={(e) => onChange({ localNetworkAccess: e.target.checked })}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{server.localNetworkAccess ? "on" : "off"}
					</span>
				</label>
			</Field>
			<Field
				label="Allow External Agents"
				hint="register agent directories outside the vault (e.g. native WSL or Windows project paths). filesystem browse is unrestricted when on; only enable on trusted machines."
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={server.allowExternalAgents}
						onChange={(e) =>
							onChange({ allowExternalAgents: e.target.checked })
						}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{server.allowExternalAgents ? "on" : "off"}
					</span>
				</label>
			</Field>

			<TailscaleFields
				server={server}
				onChange={onChange}
				status={status}
				checking={checking}
				onRefresh={() => void refresh()}
				onStartSetup={startSetup}
			/>
		</Section>
	);
}
