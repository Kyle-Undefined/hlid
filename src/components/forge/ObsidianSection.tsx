import { useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	getObsidianStatusFn,
	type ObsidianCliStatus,
	type ObsidianConnection,
	testObsidianConnectionFn,
} from "#/lib/serverFns/obsidian";
import { Field, Section, StatusIndicator } from "./fields";

export function ObsidianSection() {
	const [status, setStatus] = useState<ObsidianCliStatus | null>(null);
	const [connection, setConnection] = useState<ObsidianConnection | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function refresh() {
		setChecking(true);
		setError(null);
		try {
			setStatus(await getObsidianStatusFn());
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
		setConnection(null);
		try {
			setConnection(await testObsidianConnectionFn());
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not connect to Obsidian",
			);
		} finally {
			setChecking(false);
		}
	}

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
			{status?.installed && (
				<>
					<Field
						label="Agent access"
						hint="Claude, Codex, and ACP agents can query links, tasks, properties, Bases, and file history. These tools are read-only."
					>
						<StatusIndicator ok={true}>5 read-only tools</StatusIndicator>
					</Field>
					<Field
						label="Shell command"
						hint="Hlid can use the installed redirector directly even when it is not on PATH."
					>
						<StatusIndicator ok={status.registered}>
							{status.registered ? "registered" : "not registered"}
						</StatusIndicator>
					</Field>
					<Field
						label="Configured vault"
						hint="Testing may start Obsidian if the desktop app is closed."
					>
						<div className="flex flex-wrap items-center gap-3">
							<StatusIndicator ok={connection ? true : null}>
								{connection
									? `connected with v${connection.version}`
									: "not tested"}
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
