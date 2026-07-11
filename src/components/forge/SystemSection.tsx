import { useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import {
	getStorageStatsFn,
	optimizeStorageFn,
	type StorageStats,
} from "#/lib/serverFns";
import { Field, Section } from "./fields";

type InstallPaths = {
	exe: string;
	dir: string;
	canonical_exe: string;
	canonical_dir: string;
	is_canonical: boolean;
};

type LifecycleState = {
	enabled: boolean;
	supported: boolean;
	path?: string;
	install?: InstallPaths;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = units[0];
	for (let i = 1; i < units.length && value >= 1024; i++) {
		value /= 1024;
		unit = units[i];
	}
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function OptimizeStorageAction({
	busy,
	onOptimize,
}: {
	busy: boolean;
	onOptimize: () => void;
}) {
	return (
		<Field
			label="Optimize database"
			hint="checkpoint WAL and refresh SQLite query statistics"
		>
			<button
				type="button"
				disabled={busy}
				onClick={onOptimize}
				className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
			>
				{busy ? "OPTIMIZING…" : "OPTIMIZE"}
			</button>
		</Field>
	);
}

function ShutdownAction({
	busy,
	onShutdown,
}: {
	busy: boolean;
	onShutdown: () => void;
}) {
	return (
		<Field label="Shutdown" hint="exit Hlið completely">
			<ConfirmAction
				label="shutdown?"
				onConfirm={onShutdown}
				className="shrink-0"
				trigger={(open) => (
					<button
						type="button"
						onClick={open}
						disabled={busy}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-destructive/40 text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors uppercase disabled:opacity-40"
					>
						{busy ? "STOPPING…" : "SHUTDOWN"}
					</button>
				)}
			/>
		</Field>
	);
}

function RestartAction({
	busy,
	onRestart,
}: {
	busy: boolean;
	onRestart: () => void;
}) {
	return (
		<Field
			label="Restart"
			hint="restart Hlið and apply pending configuration changes"
		>
			<ConfirmAction
				label="restart?"
				onConfirm={onRestart}
				className="shrink-0"
				trigger={(open) => (
					<button
						type="button"
						onClick={open}
						disabled={busy}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors uppercase disabled:opacity-40"
					>
						{busy ? "RESTARTING…" : "RESTART"}
					</button>
				)}
			/>
		</Field>
	);
}

function useSystemMaintenance() {
	const [autostart, setAutostart] = useState<LifecycleState | null>(null);
	const [storage, setStorage] = useState<StorageStats | null>(null);
	const [busy, setBusy] = useState<
		null | "toggle" | "restart" | "shutdown" | "open_install_dir" | "optimize"
	>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/lifecycle");
			if (!res.ok) {
				setError("Failed to load lifecycle state");
				return;
			}
			const response = (await res.json()) as {
				ok: boolean;
				data?: LifecycleState;
			};
			if (response.ok && response.data) setAutostart(response.data);
		} catch (cause) {
			console.error("[lifecycle] Failed to fetch status:", cause);
			setError("Failed to load lifecycle state");
		}
	}, []);

	useEffect(() => {
		void refresh();
		void getStorageStatsFn()
			.then(setStorage)
			.catch(() => {});
	}, [refresh]);

	async function post(
		action:
			| "install"
			| "uninstall"
			| "restart"
			| "shutdown"
			| "open_install_dir",
	) {
		const res = await fetch("/api/lifecycle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
		if (!res.ok) {
			return { ok: false, error: `Request failed with status ${res.status}` };
		}
		return (await res.json()) as { ok: boolean; error?: string };
	}

	async function runLifecycleAction(
		action: "restart" | "shutdown" | "open_install_dir",
		fallback: string,
	) {
		setError(null);
		setBusy(action);
		try {
			const result = await post(action).catch(
				(cause) => ({ ok: false, error: String(cause) }) as const,
			);
			if (!result.ok) setError(result.error ?? fallback);
		} finally {
			setBusy(null);
		}
	}

	async function toggleAutostart() {
		if (!autostart?.supported) return;
		setError(null);
		setBusy("toggle");
		try {
			const action = autostart.enabled ? "uninstall" : "install";
			const result = await post(action).catch(
				(cause) => ({ ok: false, error: String(cause) }) as const,
			);
			if (!result.ok) setError(result.error ?? "Failed");
			await refresh();
		} finally {
			setBusy(null);
		}
	}

	async function optimizeStorage() {
		setError(null);
		setBusy("optimize");
		try {
			setStorage(await optimizeStorageFn());
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Storage optimization failed",
			);
		} finally {
			setBusy(null);
		}
	}

	return {
		autostart,
		storage,
		busy,
		error,
		optimizeStorage,
		toggleAutostart,
		openInstallDir: () =>
			runLifecycleAction("open_install_dir", "Failed to open folder"),
		doShutdown: () => runLifecycleAction("shutdown", "Shutdown failed"),
		doRestart: () => runLifecycleAction("restart", "Restart failed"),
	};
}

export function SystemSection({
	view = "all",
}: {
	view?: "all" | "overview" | "advanced";
}) {
	const {
		autostart,
		storage,
		busy,
		error,
		optimizeStorage,
		toggleAutostart,
		openInstallDir,
		doShutdown,
		doRestart,
	} = useSystemMaintenance();

	const supported = autostart?.supported ?? false;
	const enabled = autostart?.enabled ?? false;
	const install = autostart?.install;

	return (
		<>
			{view !== "advanced" && (
				<Section title="Installation and startup">
					{install && (
						<Field label="Install location" hint={install.dir}>
							<button
								type="button"
								onClick={() => {
									void openInstallDir();
								}}
								disabled={busy === "open_install_dir" || !supported}
								title={
									supported ? "open install folder in Explorer" : "Windows only"
								}
								className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
							>
								{busy === "open_install_dir" ? "OPENING…" : "OPEN"}
							</button>
						</Field>
					)}
					<Field
						label="Launch on login"
						hint={
							autostart === null
								? "checking…"
								: !supported
									? "Windows only"
									: enabled
										? "starts in background when you sign in"
										: "off; Hlid won't start automatically"
						}
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={enabled}
								disabled={!supported || busy === "toggle"}
								onChange={() => {
									void toggleAutostart();
								}}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{enabled ? "on" : "off"}
							</span>
						</label>
					</Field>
					{view === "all" && (
						<ShutdownAction
							busy={busy !== null}
							onShutdown={() => void doShutdown()}
						/>
					)}
					{error && (
						<div className="px-4 py-2 text-xs text-destructive/80">{error}</div>
					)}
				</Section>
			)}
			{view !== "advanced" && (
				<Section title="Storage summary">
					<Field
						label="Database"
						hint={
							storage
								? `${storage.sessions.toLocaleString()} sessions · ${storage.messages.toLocaleString()} messages · ${storage.usageQueries.toLocaleString()} usage rows`
								: "checking…"
						}
					>
						<span className="text-xs tabular-nums text-muted-foreground">
							{storage ? formatBytes(storage.databaseBytes) : "—"}
						</span>
					</Field>
					<Field
						label="Write-ahead log"
						hint={
							storage?.reclaimableBytes
								? `${formatBytes(storage.reclaimableBytes)} reusable inside database`
								: "SQLite WAL and reusable page space"
						}
					>
						<span className="text-xs tabular-nums text-muted-foreground">
							{storage ? formatBytes(storage.walBytes) : "—"}
						</span>
					</Field>
					<Field
						label="Tracked attachments"
						hint={
							storage
								? `${storage.trackedAttachments.toLocaleString()} files`
								: "checking…"
						}
					>
						<span className="text-xs tabular-nums text-muted-foreground">
							{storage ? formatBytes(storage.trackedAttachmentBytes) : "—"}
						</span>
					</Field>
					{view === "all" && (
						<OptimizeStorageAction
							busy={busy !== null}
							onOptimize={() => void optimizeStorage()}
						/>
					)}
				</Section>
			)}
			{view === "advanced" && (
				<div id="lifecycle-controls" className="scroll-mt-20">
					<Section
						title="Danger zone"
						description="Maintenance and lifecycle actions can interrupt active work."
					>
						<OptimizeStorageAction
							busy={busy !== null}
							onOptimize={() => void optimizeStorage()}
						/>
						<RestartAction
							busy={busy !== null}
							onRestart={() => void doRestart()}
						/>
						<ShutdownAction
							busy={busy !== null}
							onShutdown={() => void doShutdown()}
						/>
						{error && (
							<div className="px-4 py-2 text-xs text-destructive/80">
								{error}
							</div>
						)}
					</Section>
				</div>
			)}
		</>
	);
}
