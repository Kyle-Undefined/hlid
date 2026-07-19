import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CLIPROXY_CONFIG, type HlidConfig } from "#/config";
import {
	connectCliProxyCodexFn,
	getCliProxyInfoFn,
	installCliProxyFn,
	refreshCliProxyInfoFn,
	removeCliProxyFn,
	startCliProxyFn,
	stopCliProxyFn,
} from "#/lib/serverFns/cliproxy";
import type { CliProxyStatus } from "#/server/cliproxyManager";

const UNAVAILABLE_INFO: CliProxyStatus = {
	state: "error",
	managed: false,
	authenticated: false,
	oauth: "idle",
	error: "CLIProxy integration unavailable",
};

function bytes(value: number): string {
	if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function stateLabel(status: CliProxyStatus): string {
	if (status.state === "not_installed") return "Not installed";
	if (status.state === "unsupported") return "Windows only";
	return status.state.charAt(0).toUpperCase() + status.state.slice(1);
}

export function CliProxySection({
	config,
	initialInfo,
}: {
	config?: HlidConfig["cliproxy"];
	initialInfo?: CliProxyStatus;
}) {
	const [info, setInfo] = useState(initialInfo ?? UNAVAILABLE_INFO);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async (release = false) => {
		try {
			setInfo(await (release ? refreshCliProxyInfoFn() : getCliProxyInfoFn()));
		} catch {}
	}, []);

	useEffect(() => {
		if (!busy && info.oauth !== "running" && info.state !== "downloading")
			return;
		const timer = window.setInterval(() => void refresh(), 1000);
		return () => window.clearInterval(timer);
	}, [busy, info.oauth, info.state, refresh]);

	async function run(
		label: string,
		action: () => Promise<CliProxyStatus>,
		reload = false,
	) {
		setBusy(label);
		setError(null);
		try {
			setInfo(await action());
			if (reload) window.location.reload();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : `${label} failed`);
			await refresh();
		} finally {
			setBusy(null);
		}
	}

	const installed = Boolean(info.installedVersion);
	const running = info.state === "running" || info.state === "starting";
	const integrationConfig = config ?? DEFAULT_CLIPROXY_CONFIG;
	const external =
		integrationConfig.mode === "external" && integrationConfig.enabled;

	return (
		<section className="border border-border bg-card p-4 space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-sm">CLIProxyAPI</h2>
					<p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
						Run Codex models through Claude Code while Hlid owns the proxy,
						credentials, startup, and lifecycle.
					</p>
				</div>
				<div className="text-right">
					<div className="text-[10px] tracking-widest uppercase text-muted-foreground">
						{external ? "External" : stateLabel(info)}
					</div>
					{info.installedVersion && (
						<div className="text-xs mt-1">v{info.installedVersion}</div>
					)}
				</div>
			</div>

			{external ? (
				<div className="border border-border/70 bg-background/40 p-3 text-xs">
					<div>
						Using an externally managed instance at {integrationConfig.base_url}
						.
					</div>
					<p className="text-muted-foreground mt-1">
						Switch to the managed install by choosing Install below. Hlid never
						sends the configured API key to the browser.
					</p>
				</div>
			) : (
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="border border-border/70 bg-background/40 p-3">
						<div className="text-[10px] tracking-widest uppercase text-muted-foreground">
							Codex account
						</div>
						<div className="text-sm mt-1">
							{info.authenticated ? "Connected" : "Not connected"}
						</div>
						<p className="text-xs text-muted-foreground mt-1">
							Sign-in opens on the Windows machine running Hlid. Tokens stay in
							Hlid's private integration directory.
						</p>
					</div>
					<div className="border border-border/70 bg-background/40 p-3">
						<div className="text-[10px] tracking-widest uppercase text-muted-foreground">
							Accounting
						</div>
						<div className="text-sm mt-1">Separate provider estimate</div>
						<p className="text-xs text-muted-foreground mt-1">
							Ledger records SDK tokens and model under Claude Code · Codex,
							then estimates cost from Hlid's Codex pricing catalog.
						</p>
					</div>
				</div>
			)}

			{info.download && (
				<div className="text-xs text-muted-foreground" aria-live="polite">
					Downloaded {bytes(info.download.received)}
					{info.download.total ? ` of ${bytes(info.download.total)}` : ""}
				</div>
			)}
			{(error || info.error) && (
				<div className="text-xs text-destructive" role="alert">
					{error || info.error}
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				{(!installed || external) && (
					<button
						type="button"
						disabled={Boolean(busy) || info.state === "unsupported"}
						onClick={() => void run("install", installCliProxyFn, true)}
						className="px-3 py-1.5 bg-primary text-primary-foreground text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						{busy === "install" ? "Installing…" : "Install managed"}
					</button>
				)}
				{installed && !external && !running && (
					<button
						type="button"
						disabled={Boolean(busy)}
						onClick={() => void run("start", startCliProxyFn, true)}
						className="px-3 py-1.5 bg-primary text-primary-foreground text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						Enable
					</button>
				)}
				{installed && !external && running && (
					<button
						type="button"
						disabled={Boolean(busy)}
						onClick={() => void run("stop", stopCliProxyFn, true)}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						Disable
					</button>
				)}
				{installed && !external && !info.authenticated && (
					<button
						type="button"
						disabled={Boolean(busy) || info.oauth === "running"}
						onClick={() => void run("oauth", connectCliProxyCodexFn)}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-50"
					>
						{info.oauth === "running"
							? "Waiting for sign-in…"
							: "Connect Codex"}
					</button>
				)}
				{installed && !external && (
					<>
						<button
							type="button"
							disabled={Boolean(busy)}
							onClick={() => void run("update", installCliProxyFn, true)}
							className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-50"
						>
							{info.updateAvailable
								? `Update to v${info.latestVersion}`
								: "Check / repair"}
						</button>
						<button
							type="button"
							disabled={Boolean(busy)}
							onClick={() => {
								if (
									!window.confirm(
										"Remove CLIProxyAPI and its saved Codex sign-in from this machine?",
									)
								)
									return;
								void run("remove", removeCliProxyFn, true);
							}}
							className="px-3 py-1.5 border border-destructive/50 text-destructive text-[10px] tracking-widest uppercase disabled:opacity-50"
						>
							Remove
						</button>
					</>
				)}
				<button
					type="button"
					disabled={Boolean(busy)}
					onClick={() => void refresh(true)}
					className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-50"
				>
					Refresh
				</button>
			</div>
		</section>
	);
}
