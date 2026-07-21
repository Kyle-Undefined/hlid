import { useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	getObsidianStatusFn,
	type ObsidianIntegrationStatus,
	testObsidianConnectionFn,
} from "#/lib/serverFns/obsidian";
import { Field, Section, StatusIndicator } from "./fields";

export function ObsidianSection({
	rememberedCommands,
	onRememberedCommandsChange,
}: {
	rememberedCommands: string[];
	onRememberedCommandsChange: (commands: string[]) => void;
}) {
	const [status, setStatus] = useState<ObsidianIntegrationStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function refresh() {
		setChecking(true);
		setError(null);
		try {
			const nextStatus = await getObsidianStatusFn();
			setStatus(nextStatus);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not detect Obsidian CLI",
			);
		} finally {
			setChecking(false);
		}
	}

	// Detection is intentionally mount-only. The explicit Recheck action owns
	// later refreshes so Forge does not poll the Windows host.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only passive detection
	useEffect(() => {
		void refresh();
	}, []);

	async function testConnection() {
		setChecking(true);
		setError(null);
		try {
			const connection = await testObsidianConnectionFn();
			setStatus((current) =>
				current
					? {
							...current,
							connection: {
								vaultName: current.connection.vaultName,
								state: "connected",
								connection,
								error: null,
								checkedAt: Date.now(),
							},
						}
					: current,
			);
		} catch (cause) {
			const message =
				cause instanceof Error
					? cause.message
					: "Could not connect to Obsidian";
			setStatus((current) =>
				current
					? {
							...current,
							connection: {
								vaultName: current.connection.vaultName,
								state: "failed",
								connection: null,
								error: message,
								checkedAt: Date.now(),
							},
						}
					: current,
			);
			setError(message);
		} finally {
			setChecking(false);
		}
	}

	const connectionSnapshot = status?.connection;
	const connection = connectionSnapshot?.connection;

	return (
		<Section title="Obsidian desktop">
			<Field label="CLI available" hint={status?.detail}>
				<div className="flex flex-wrap items-center gap-3">
					<StatusIndicator ok={status ? status.installed : null}>
						{status
							? status.installed
								? status.version
									? `v${status.version}`
									: "detected"
								: status.supported
									? "not detected"
									: "unsupported"
							: "checking…"}
					</StatusIndicator>
					<button
						type="button"
						onClick={() => void refresh()}
						disabled={checking}
						className="px-2 py-1 border border-border text-[10px] tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground uppercase disabled:opacity-40"
					>
						{checking ? "…" : "Recheck"}
					</button>
				</div>
			</Field>
			{status?.installed && connectionSnapshot && (
				<>
					<Field
						label="Agent access"
						hint="Claude, Codex, and ACP agents receive Hlid's curated Obsidian tools automatically. Vault reads prefer Obsidian's index; note changes follow the active agent permission policy."
					>
						<StatusIndicator ok={true}>
							{status.agentTools.length} curated tools
						</StatusIndicator>
					</Field>
					<Field
						label="Remembered command approvals"
						hint="commands trusted with Always for this configured vault"
					>
						{rememberedCommands.length === 0 ? (
							<span className="text-xs text-muted-foreground">
								None yet. Agents discover commands and request approval when
								needed.
							</span>
						) : (
							<div className="flex w-48 flex-wrap gap-1">
								{rememberedCommands.map((command) => (
									<span
										key={command}
										className="inline-flex max-w-full items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
									>
										<span className="truncate" title={command}>
											{command}
										</span>
										<button
											type="button"
											onClick={() =>
												onRememberedCommandsChange(
													rememberedCommands.filter((item) => item !== command),
												)
											}
											aria-label={`Forget approved Obsidian command ${command}`}
											className="hover:text-destructive"
										>
											×
										</button>
									</span>
								))}
							</div>
						)}
					</Field>
					<Field
						label="Configured vault"
						hint={
							connectionSnapshot.error ??
							"Checked once when Hlid starts. Testing may start Obsidian if the desktop app is closed."
						}
					>
						<div className="flex flex-wrap items-center gap-3">
							<StatusIndicator
								ok={
									connection
										? true
										: connectionSnapshot.state === "failed"
											? false
											: null
								}
							>
								{connection
									? `connected with v${connection.version}`
									: connectionSnapshot.state === "checking"
										? "checking…"
										: "not connected"}
							</StatusIndicator>
							<button
								type="button"
								onClick={() => void testConnection()}
								disabled={checking}
								className="px-2 py-1 border border-border text-[10px] tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground uppercase disabled:opacity-40"
							>
								{checking ? "…" : "Test connection"}
							</button>
						</div>
					</Field>
					{connection?.vaultPath && (
						<div className="px-4 py-3 space-y-1">
							<div className="text-xs text-muted-foreground">
								Obsidian target
							</div>
							<PrivacyMask className="font-mono text-xs text-foreground/75 break-all">
								{connection.vaultPath}
							</PrivacyMask>
						</div>
					)}
				</>
			)}
			{!status?.installed && status !== null && (
				<div className="px-4 py-3 text-xs text-muted-foreground leading-relaxed">
					Install Obsidian 1.12.7 or newer, then enable the
					<strong className="text-foreground/75">
						{" "}
						Command line interface{" "}
					</strong>
					setting under Obsidian Settings → General.
					<a
						href="https://obsidian.md/help/cli"
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						Setup guide
					</a>
				</div>
			)}
			{error && (
				<div className="px-4 py-3 text-xs text-destructive" role="alert">
					{error}
				</div>
			)}
		</Section>
	);
}
