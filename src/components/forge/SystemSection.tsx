import { useCallback, useEffect, useState } from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
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

export function SystemSection() {
	const [autostart, setAutostart] = useState<LifecycleState | null>(null);
	const [busy, setBusy] = useState<
		null | "toggle" | "shutdown" | "open_install_dir"
	>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/lifecycle");
			if (!res.ok) {
				setError("Failed to load lifecycle state");
				return;
			}
			const j = (await res.json()) as {
				ok: boolean;
				data?: LifecycleState;
			};
			if (j.ok && j.data) setAutostart(j.data);
		} catch (e) {
			console.error("[lifecycle] Failed to fetch status:", e);
			setError("Failed to load lifecycle state");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function post(
		action: "install" | "uninstall" | "shutdown" | "open_install_dir",
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

	async function openInstallDir() {
		setError(null);
		setBusy("open_install_dir");
		const r = await post("open_install_dir").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!r.ok) setError(r.error ?? "Failed to open folder");
		setBusy(null);
	}

	async function toggleAutostart() {
		if (!autostart?.supported) return;
		setError(null);
		setBusy("toggle");
		try {
			const action = autostart.enabled ? "uninstall" : "install";
			const r = await post(action).catch(
				(e) => ({ ok: false, error: String(e) }) as const,
			);
			if (!r.ok) setError(r.error ?? "Failed");
			await refresh();
		} finally {
			setBusy(null);
		}
	}

	async function doShutdown() {
		setError(null);
		setBusy("shutdown");
		try {
			const r = await post("shutdown").catch(
				(e) => ({ ok: false, error: String(e) }) as const,
			);
			if (!r.ok) {
				setError(r.error ?? "Shutdown failed");
			}
		} finally {
			setBusy(null);
		}
	}

	const supported = autostart?.supported ?? false;
	const enabled = autostart?.enabled ?? false;
	const install = autostart?.install;

	return (
		<Section title="System">
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
			<Field label="Shutdown" hint="exit Hlid completely">
				<ConfirmAction
					label="shutdown?"
					onConfirm={() => void doShutdown()}
					className="shrink-0"
					trigger={(open) => (
						<button
							type="button"
							onClick={open}
							disabled={busy !== null}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-destructive/40 text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors uppercase disabled:opacity-40"
						>
							{busy === "shutdown" ? "STOPPING…" : "SHUTDOWN"}
						</button>
					)}
				/>
			</Field>
			{error && (
				<div className="px-4 py-2 text-xs text-destructive/80">{error}</div>
			)}
		</Section>
	);
}
