import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CLIPROXY_CONFIG, type HlidConfig } from "#/config";
import {
	connectCliProxyAntigravityFn,
	connectCliProxyClaudeFn,
	connectCliProxyCodexFn,
	connectCliProxyKimiFn,
	connectCliProxyXaiFn,
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
	accounts: {
		codex: "idle",
		claude: "idle",
		antigravity: "idle",
		kimi: "idle",
		xai: "idle",
	},
	error: "CLIProxy integration unavailable",
};

const OAUTH_ACCOUNTS = [
	{ id: "codex", label: "OpenAI Codex" },
	{ id: "claude", label: "Anthropic Claude" },
	{ id: "antigravity", label: "Google Antigravity" },
	{ id: "kimi", label: "Moonshot Kimi" },
	{ id: "xai", label: "xAI" },
] as const;

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
		if (!busy && !info.activeOAuth && info.state !== "downloading") return;
		const timer = window.setInterval(() => void refresh(), 1000);
		return () => window.clearInterval(timer);
	}, [busy, info.activeOAuth, info.state, refresh]);

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

	function connectAccount(id: (typeof OAUTH_ACCOUNTS)[number]["id"]) {
		if (id === "codex") return connectCliProxyCodexFn();
		if (id === "claude") return connectCliProxyClaudeFn();
		if (id === "antigravity") return connectCliProxyAntigravityFn();
		if (id === "kimi") return connectCliProxyKimiFn();
		return connectCliProxyXaiFn();
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
						Route models from connected OAuth accounts through Claude Code,
						Codex, or OpenCode while Hlid owns the proxy and lifecycle.
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
							OAuth accounts
						</div>
						<div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
							{OAUTH_ACCOUNTS.map((account) => (
								<span key={account.id}>
									{account.label}:{" "}
									{info.accounts[account.id] === "connected"
										? "Connected"
										: info.accounts[account.id] === "running"
											? "Waiting"
											: "Not connected"}
								</span>
							))}
						</div>
						<p className="text-xs text-muted-foreground mt-1">
							Sign-in opens on the Windows host. Tokens stay in Hlid's private
							integration directory.
						</p>
					</div>
					<div className="border border-border/70 bg-background/40 p-3">
						<div className="text-[10px] tracking-widest uppercase text-muted-foreground">
							Accounting
						</div>
						<div className="text-sm mt-1">Harness + model attribution</div>
						<p className="text-xs text-muted-foreground mt-1">
							Ledger records the harness route and actual model. Hlid estimates
							known OpenAI and Anthropic models; other families remain unpriced.
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
				{installed &&
					!external &&
					OAUTH_ACCOUNTS.map((account) => (
						<button
							key={account.id}
							type="button"
							disabled={Boolean(busy) || Boolean(info.activeOAuth)}
							onClick={() =>
								void run(`oauth-${account.id}`, () =>
									connectAccount(account.id),
								)
							}
							className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase disabled:opacity-50"
						>
							{info.activeOAuth === account.id
								? "Waiting for sign-in…"
								: info.accounts[account.id] === "connected"
									? `Reconnect ${account.label}`
									: `Connect ${account.label}`}
						</button>
					))}
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
										"Remove CLIProxyAPI and all of its saved OAuth accounts from this machine?",
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
