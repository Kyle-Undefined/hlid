import { useCallback, useEffect, useRef, useState } from "react";
import { Field, Section } from "./fields";

type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	error?: string;
};

type ApplyState =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "downloading" }
	| { phase: "downloaded"; stagedExe: string; targetVersion: string }
	| { phase: "launching"; targetVersion: string }
	| { phase: "error"; message: string };

function relativeTime(epochMs: number | null | undefined): string {
	if (epochMs == null || !Number.isFinite(epochMs)) return "never";
	const diff = Date.now() - epochMs;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function UpdatesSection() {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [state, setState] = useState<ApplyState>({ phase: "idle" });
	const [fetchError, setFetchError] = useState<string | null>(null);
	// Persists the version at launch time so the polling effect doesn't lose it
	// when status changes and the effect dependency re-evaluates.
	const launchingStartVersionRef = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		setFetchError(null);
		try {
			const res = await fetch("/api/updates");
			const j = (await res.json()) as { ok: boolean; data?: UpdateStatus };
			if (j.ok && j.data) setStatus(j.data);
		} catch (e) {
			console.error("[updates] fetch failed:", e);
			setFetchError(e instanceof Error ? e.message : "fetch failed");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// While launching, hit /api/version every 1.5s. When the version response
	// changes (new instance is up after the staged exe took canonical), reload
	// so dad sees a fresh page on the new build.
	useEffect(() => {
		if (state.phase !== "launching") return;
		// Read from ref (captured in launchStaged) to avoid stale closure when
		// status changes and this effect would otherwise re-run.
		const startVersion = launchingStartVersionRef.current;
		const id = setInterval(async () => {
			try {
				const r = await fetch("/api/version", { cache: "no-store" });
				if (!r.ok) return;
				const j = (await r.json()) as { version?: string };
				if (j.version && j.version !== startVersion) {
					window.location.reload();
				}
			} catch {
				// Brief disconnect mid-restart is expected; keep polling.
			}
		}, 1500);
		const deadline = setTimeout(
			() => {
				clearInterval(id);
				setState({
					phase: "error",
					message: "timed out waiting for new version — refresh manually",
				});
			},
			5 * 60 * 1000,
		);
		return () => {
			clearInterval(id);
			clearTimeout(deadline);
		};
	}, [state.phase]);

	async function postAction(
		action: "check" | "download" | "apply",
		extra?: Record<string, unknown>,
	): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		const res = await fetch("/api/updates", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ...(extra ?? {}) }),
		});
		return (await res.json()) as {
			ok: boolean;
			data?: unknown;
			error?: string;
		};
	}

	async function checkNow() {
		setState({ phase: "checking" });
		const r = await postAction("check").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (r.ok && r.data) {
			setStatus(r.data as UpdateStatus);
			setState({ phase: "idle" });
		} else {
			setState({ phase: "error", message: r.error ?? "check failed" });
		}
	}

	// Download + checksum-verify the new exe, then surface a "Launch" button.
	// We don't auto-launch because Windows SmartScreen only renders its
	// "More info → Run anyway" prompt when the launch comes from an
	// interactive shell context. Routing the launch through `explorer.exe
	// <stagedExe>` (server-side) on a user click is what gets the prompt
	// in front of the user; a programmatic spawn is silently suppressed
	// for unsigned binaries with no SmartScreen reputation.
	async function downloadOnly() {
		setState({ phase: "downloading" });
		const dl = await postAction("download").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!dl.ok) {
			setState({ phase: "error", message: dl.error ?? "download failed" });
			return;
		}
		const data = dl.data as { stagedExe: string; version: string } | undefined;
		if (!data?.stagedExe || !data?.version) {
			setState({
				phase: "error",
				message: "incomplete download response (missing stagedExe or version)",
			});
			return;
		}
		setState({
			phase: "downloaded",
			stagedExe: data.stagedExe,
			targetVersion: data.version,
		});
	}

	async function launchStaged(stagedExe: string, targetVersion: string) {
		launchingStartVersionRef.current = status?.current ?? null;
		setState({ phase: "launching", targetVersion });
		const ap = await postAction("apply", { stagedExe }).catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!ap.ok) {
			setState({ phase: "error", message: ap.error ?? "launch failed" });
		}
		// On success the staged exe's maybeSelfInstall path will POST a
		// shutdown to the running canonical; the polling effect above
		// takes over and reloads when the new version answers.
	}

	const current = status?.current ?? "—";
	const latest = status?.latest;
	const available = status?.available ?? false;

	return (
		<Section title="Updates">
			<Field
				label="Version"
				hint={
					fetchError
						? `error: ${fetchError}`
						: status === null
							? "loading…"
							: available && latest
								? `update available: v${latest}`
								: "you're on the latest version"
				}
			>
				{fetchError ? (
					<button
						type="button"
						onClick={() => void refresh()}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase"
					>
						RETRY
					</button>
				) : (
					<span className="text-xs font-mono text-muted-foreground">
						v{current}
						{available && latest ? (
							<>
								{" "}
								<span className="text-foreground">→ v{latest}</span>
							</>
						) : null}
					</span>
				)}
			</Field>

			<Field
				label="Check for updates"
				hint={
					status?.lastCheckedAt
						? `last checked ${relativeTime(status.lastCheckedAt)}`
						: "never checked"
				}
			>
				<button
					type="button"
					onClick={() => {
						void checkNow();
					}}
					disabled={state.phase !== "idle" && state.phase !== "error"}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
				>
					{state.phase === "checking" ? "CHECKING…" : "CHECK"}
				</button>
			</Field>

			{available && state.phase !== "downloaded" && (
				<Field label="Download update" hint="fetches and verifies the new exe">
					<button
						type="button"
						onClick={() => {
							void downloadOnly();
						}}
						disabled={state.phase !== "idle" && state.phase !== "error"}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-40"
					>
						{state.phase === "downloading" ? "DOWNLOADING…" : "DOWNLOAD"}
					</button>
				</Field>
			)}

			{state.phase === "downloaded" && (
				<Field
					label="Launch installer"
					hint="opens the new exe via Windows shell — accept the SmartScreen prompt to install"
				>
					<button
						type="button"
						onClick={() => {
							void launchStaged(state.stagedExe, state.targetVersion);
						}}
						disabled={state.phase !== "downloaded"}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-40"
					>
						LAUNCH v{state.targetVersion}
					</button>
				</Field>
			)}

			{state.phase === "launching" && (
				<div className="px-4 py-2 text-xs text-muted-foreground">
					launching v{state.targetVersion} — accept the SmartScreen prompt if it
					appears. page will reload when the new version is up.
				</div>
			)}

			{state.phase === "error" && (
				<div className="px-4 py-2 text-xs text-destructive/80">
					{state.message}
				</div>
			)}
			{status?.error && state.phase !== "error" && (
				<div className="px-4 py-2 text-xs text-muted-foreground/70">
					last check: {status.error}
				</div>
			)}
		</Section>
	);
}
