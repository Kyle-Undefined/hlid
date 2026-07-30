import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	getObsidianStatusFn,
	type ObsidianIntegrationStatus,
	testObsidianConnectionFn,
} from "#/lib/serverFns/obsidian";
import { Field, Section, StatusIndicator } from "./fields";

type ObsidianSectionState = {
	status: ObsidianIntegrationStatus | null;
	checking: boolean;
	error: string | null;
};

type SetObsidianSectionState = Dispatch<SetStateAction<ObsidianSectionState>>;

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

async function refreshObsidianStatus(
	setState: SetObsidianSectionState,
): Promise<void> {
	setState((current) => ({ ...current, checking: true, error: null }));
	try {
		const status = await getObsidianStatusFn();
		setState((current) => ({ ...current, status }));
	} catch (cause) {
		setState((current) => ({
			...current,
			error: errorMessage(cause, "Could not detect Obsidian CLI"),
		}));
	} finally {
		setState((current) => ({ ...current, checking: false }));
	}
}

async function testObsidianConnection(
	setState: SetObsidianSectionState,
): Promise<void> {
	setState((current) => ({ ...current, checking: true, error: null }));
	try {
		const connection = await testObsidianConnectionFn();
		setState((current) => ({
			...current,
			status: current.status
				? {
						...current.status,
						connection: {
							vaultName: current.status.connection.vaultName,
							state: "connected",
							connection,
							error: null,
							checkedAt: Date.now(),
						},
					}
				: current.status,
		}));
	} catch (cause) {
		const error = errorMessage(cause, "Could not connect to Obsidian");
		setState((current) => ({
			...current,
			error,
			status: current.status
				? {
						...current.status,
						connection: {
							vaultName: current.status.connection.vaultName,
							state: "failed",
							connection: null,
							error,
							checkedAt: Date.now(),
						},
					}
				: current.status,
		}));
	} finally {
		setState((current) => ({ ...current, checking: false }));
	}
}

function useObsidianSectionState() {
	const [state, setState] = useState<ObsidianSectionState>({
		status: null,
		checking: false,
		error: null,
	});
	// Detection is intentionally mount-only. The explicit Recheck action owns
	// later refreshes so Forge does not poll the Windows host.
	useEffect(() => {
		void refreshObsidianStatus(setState);
	}, []);
	return {
		...state,
		refresh: () => refreshObsidianStatus(setState),
		testConnection: () => testObsidianConnection(setState),
	};
}

function CliStatusField({
	status,
	checking,
	onRefresh,
}: {
	status: ObsidianIntegrationStatus | null;
	checking: boolean;
	onRefresh: () => Promise<void>;
}) {
	const label = status
		? status.installed
			? status.version
				? `v${status.version}`
				: "detected"
			: status.supported
				? "not detected"
				: "unsupported"
		: "checking…";
	return (
		<Field label="CLI available" hint={status?.detail}>
			<div className="flex flex-wrap items-center gap-3">
				<StatusIndicator ok={status ? status.installed : null}>
					{label}
				</StatusIndicator>
				<button
					type="button"
					onClick={() => void onRefresh()}
					disabled={checking}
					className="px-2 py-1 border border-border text-[10px] tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground uppercase disabled:opacity-40"
				>
					{checking ? "…" : "Recheck"}
				</button>
			</div>
		</Field>
	);
}

function RememberedCommandsField({
	commands,
	onChange,
}: {
	commands: string[];
	onChange: (commands: string[]) => void;
}) {
	return (
		<Field
			label="Remembered command approvals"
			hint="commands trusted with Always for this configured vault"
		>
			{commands.length === 0 ? (
				<span className="text-xs text-muted-foreground">
					None yet. Agents discover commands and request approval when needed.
				</span>
			) : (
				<div className="flex w-48 flex-wrap gap-1">
					{commands.map((command) => (
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
									onChange(commands.filter((item) => item !== command))
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
	);
}

function VaultConnectionField({
	snapshot,
	checking,
	onTest,
}: {
	snapshot: ObsidianIntegrationStatus["connection"];
	checking: boolean;
	onTest: () => Promise<void>;
}) {
	const connection = snapshot.connection;
	const ok = connection ? true : snapshot.state === "failed" ? false : null;
	const label = connection
		? `connected with v${connection.version}`
		: snapshot.state === "checking"
			? "checking…"
			: "not connected";
	return (
		<Field
			label="Configured vault"
			hint={
				snapshot.error ??
				"Checked once when Hlid starts. Testing may start Obsidian if the desktop app is closed."
			}
		>
			<div className="flex flex-wrap items-center gap-3">
				<StatusIndicator ok={ok}>{label}</StatusIndicator>
				<button
					type="button"
					onClick={() => void onTest()}
					disabled={checking}
					className="px-2 py-1 border border-border text-[10px] tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground uppercase disabled:opacity-40"
				>
					{checking ? "…" : "Test connection"}
				</button>
			</div>
		</Field>
	);
}

function ConnectedObsidianFields({
	status,
	rememberedCommands,
	onRememberedCommandsChange,
	checking,
	onTest,
}: {
	status: ObsidianIntegrationStatus;
	rememberedCommands: string[];
	onRememberedCommandsChange: (commands: string[]) => void;
	checking: boolean;
	onTest: () => Promise<void>;
}) {
	return (
		<>
			<Field
				label="Agent access"
				hint="Claude, Codex, and ACP agents receive Hlid's curated Obsidian tools automatically. Vault reads prefer Obsidian's index; note changes follow the active agent permission policy."
			>
				<StatusIndicator ok={true}>
					{status.agentTools.length} curated tools
				</StatusIndicator>
			</Field>
			<RememberedCommandsField
				commands={rememberedCommands}
				onChange={onRememberedCommandsChange}
			/>
			<VaultConnectionField
				snapshot={status.connection}
				checking={checking}
				onTest={onTest}
			/>
			{status.connection.connection?.vaultPath && (
				<div className="px-4 py-3 space-y-1">
					<div className="text-xs text-muted-foreground">Obsidian target</div>
					<PrivacyMask className="font-mono text-xs text-foreground/75 break-all">
						{status.connection.connection.vaultPath}
					</PrivacyMask>
				</div>
			)}
		</>
	);
}

function ObsidianSetupGuide() {
	return (
		<div className="px-4 py-3 text-xs text-muted-foreground leading-relaxed">
			Install Obsidian 1.12.7 or newer, then enable the
			<strong className="text-foreground/75"> Command line interface </strong>
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
	);
}

export function ObsidianSection({
	rememberedCommands,
	onRememberedCommandsChange,
}: {
	rememberedCommands: string[];
	onRememberedCommandsChange: (commands: string[]) => void;
}) {
	const { status, checking, error, refresh, testConnection } =
		useObsidianSectionState();

	return (
		<Section title="Obsidian desktop">
			<CliStatusField status={status} checking={checking} onRefresh={refresh} />
			{status?.installed && (
				<ConnectedObsidianFields
					status={status}
					rememberedCommands={rememberedCommands}
					onRememberedCommandsChange={onRememberedCommandsChange}
					checking={checking}
					onTest={testConnection}
				/>
			)}
			{!status?.installed && status !== null && <ObsidianSetupGuide />}
			{error && (
				<div className="px-4 py-3 text-xs text-destructive" role="alert">
					{error}
				</div>
			)}
		</Section>
	);
}
