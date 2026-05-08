import { Field, Section, TextInput } from "./fields";

// ServerForm includes TLS fields so TailscaleSection can share the same
// grouped state object — forge.tsx passes them through to TailscaleSection.
export type ServerForm = {
	port: string;
	tlsCertPath: string;
	tlsKeyPath: string;
	tlsProxyPort: string;
	localNetworkAccess: boolean;
	allowExternalAgents: boolean;
};

export function ServerSection({
	server,
	onChange,
}: {
	server: ServerForm;
	onChange: (patch: Partial<ServerForm>) => void;
}) {
	return (
		<Section title="Server">
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
		</Section>
	);
}
