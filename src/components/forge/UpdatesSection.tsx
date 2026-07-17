import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ConfirmAction } from "#/components/ConfirmAction";
import { MarkdownBody } from "#/components/MarkdownBody";
import {
	getUpdateServerSnapshot,
	getUpdateSnapshot,
	setUpdateStatus,
	subscribeUpdateStatus,
	type UpdateStatus,
} from "#/hooks/updateStore";
import type { CliUpdateStatus } from "#/lib/cliUpdateTypes";
import type { ReleaseNotes } from "#/lib/updates";
import { CliUpdateTerminalModal } from "./CliUpdateTerminalModal";
import { Field, Section } from "./fields";

type ApplyState =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "downloading" }
	| { phase: "downloaded"; targetVersion: string }
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

function updateHint(
	status: UpdateStatus | null,
	fetchError: string | null,
): string {
	if (fetchError) return `error: ${fetchError}`;
	if (!status) return "loading…";
	if (status.available && status.latest)
		return `update available: v${status.latest}`;
	return "you're on the latest version";
}

function releaseDate(publishedAt: string | null): string | null {
	if (!publishedAt) return null;
	const date = new Date(publishedAt);
	if (!Number.isFinite(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
	}).format(date);
}

function LatestChanges({ release }: { release: ReleaseNotes }) {
	const published = releaseDate(release.publishedAt);
	return (
		<Section
			title="Latest changes"
			description="Release notes from the latest published Hlið release."
		>
			<div className="min-w-0 px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<div className="break-words text-sm font-medium text-foreground">
						{release.name}
					</div>
					<div className="text-xs text-muted-foreground">
						v{release.version}
						{published ? ` · Published ${published}` : ""}
					</div>
				</div>
				<a
					href={release.url}
					target="_blank"
					rel="noreferrer"
					className="max-w-full self-start whitespace-normal break-words text-center text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase"
				>
					View on GitHub
				</a>
			</div>
			<div className="min-w-0 max-w-full overflow-x-hidden break-words px-4 py-4 text-sm text-foreground/85 [&_a]:break-all [&_code]:break-all">
				<MarkdownBody content={release.notes} />
			</div>
		</Section>
	);
}

function VersionField({
	status,
	fetchError,
	onRefresh,
}: {
	status: UpdateStatus | null;
	fetchError: string | null;
	onRefresh: () => void;
}) {
	if (fetchError) {
		return (
			<Field label="Version" hint={updateHint(status, fetchError)}>
				<button
					type="button"
					onClick={onRefresh}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase"
				>
					RETRY
				</button>
			</Field>
		);
	}
	return (
		<Field label="Version" hint={updateHint(status, null)}>
			<span className="text-xs font-mono text-muted-foreground">
				v{status?.current ?? "—"}
				{status?.available && status.latest && (
					<span className="text-foreground"> → v{status.latest}</span>
				)}
			</span>
		</Field>
	);
}

function UpdateApplyFields({
	status,
	state,
	busy,
	onDownload,
	onLaunch,
}: {
	status: UpdateStatus | null;
	state: ApplyState;
	busy: boolean;
	onDownload: () => void;
	onLaunch: (version: string) => void;
}) {
	if (state.phase === "downloaded") {
		return (
			<Field
				label="Launch installer"
				hint="opens the new exe via Windows shell — accept the SmartScreen prompt to install"
			>
				<button
					type="button"
					onClick={() => onLaunch(state.targetVersion)}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase"
				>
					LAUNCH v{state.targetVersion}
				</button>
			</Field>
		);
	}
	if (!status?.available) return null;
	return (
		<Field label="Download update" hint="fetches and verifies the new exe">
			<button
				type="button"
				onClick={onDownload}
				disabled={busy}
				className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-40"
			>
				{state.phase === "downloading" ? "DOWNLOADING…" : "DOWNLOAD"}
			</button>
		</Field>
	);
}

function UpdateNotices({
	status,
	state,
}: {
	status: UpdateStatus | null;
	state: ApplyState;
}) {
	if (state.phase === "launching") {
		return (
			<div className="px-4 py-2 text-xs text-muted-foreground">
				launching v{state.targetVersion} — accept the SmartScreen prompt if it
				appears. page will reload when the new version is up.
			</div>
		);
	}
	if (state.phase === "error") {
		return (
			<div className="px-4 py-2 text-xs text-destructive/80">
				{state.message}
			</div>
		);
	}
	return status?.error ? (
		<div className="px-4 py-2 text-xs text-muted-foreground/70">
			last check: {status.error}
		</div>
	) : null;
}

function UpdatesView({
	status,
	state,
	fetchError,
	onRefresh,
	onCheck,
	onDownload,
	onLaunch,
	cliBusyId,
	cliNotice,
	onCliUpdate,
}: {
	status: UpdateStatus | null;
	state: ApplyState;
	fetchError: string | null;
	onRefresh: () => void;
	onCheck: () => void;
	onDownload: () => void;
	onLaunch: (version: string) => void;
	cliBusyId: string | null;
	cliNotice: string | null;
	onCliUpdate: (update: CliUpdateStatus) => void;
}) {
	const busy = state.phase !== "idle" && state.phase !== "error";
	return (
		<Section title="Updates">
			<VersionField
				status={status}
				fetchError={fetchError}
				onRefresh={onRefresh}
			/>

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
					onClick={onCheck}
					disabled={busy}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
				>
					{state.phase === "checking" ? "CHECKING…" : "CHECK"}
				</button>
			</Field>

			<UpdateApplyFields
				status={status}
				state={state}
				busy={busy}
				onDownload={onDownload}
				onLaunch={onLaunch}
			/>
			{status?.cliUpdates?.map((update) => (
				<Field
					key={update.id}
					label={
						update.surface === "desktop" ? update.label : `${update.label} CLI`
					}
					hint={
						update.error
							? `check incomplete: ${update.error}`
							: update.available
								? update.surface === "desktop"
									? `Store update available: package v${update.latestVersion}`
									: `update available: v${update.latestVersion}`
								: "you're on the latest version"
					}
				>
					<div className="flex flex-col items-end gap-1.5 min-w-0">
						<span className="text-xs font-mono text-muted-foreground">
							v{update.appVersion ?? update.installedVersion ?? "—"}
							{(update.surface !== "desktop" || !update.appVersion) &&
								update.available &&
								update.latestVersion && (
									<span className="text-foreground">
										{" "}
										→ v{update.latestVersion}
									</span>
								)}
						</span>
						{update.surface === "desktop" &&
							update.appVersion &&
							update.installedVersion && (
								<span className="text-[9px] font-mono text-muted-foreground/60">
									Store package v{update.installedVersion}
									{update.available && update.latestVersion
										? ` → v${update.latestVersion}`
										: ""}
								</span>
							)}
						{update.available && (
							<code className="max-w-full select-all break-all text-right text-[9px] text-primary/75">
								{update.updateCommand ?? "update using the original installer"}
							</code>
						)}
						{update.available &&
							update.updateCommand &&
							status.cliUpdateActionsAllowed && (
								<ConfirmAction
									label={
										update.surface === "desktop"
											? "update desktop app?"
											: update.updateMode === "automatic"
												? "stop sessions and update?"
												: "stop sessions and open terminal?"
									}
									confirmText={
										update.updateMode === "automatic" ? "update" : "open"
									}
									variant="primary"
									onConfirm={() => onCliUpdate(update)}
									className="justify-end flex-wrap"
									trigger={(open) => (
										<button
											type="button"
											disabled={cliBusyId !== null}
											onClick={open}
											className="text-[9px] tracking-widest px-2.5 py-1 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-40"
										>
											{cliBusyId === update.id
												? update.updateMode === "automatic"
													? "UPDATING…"
													: "OPENING…"
												: update.updateMode === "automatic"
													? "UPDATE"
													: "OPEN TERMINAL"}
										</button>
									)}
								/>
							)}
					</div>
				</Field>
			))}
			{cliNotice && (
				<div className="px-4 py-2 text-xs text-muted-foreground">
					{cliNotice}
				</div>
			)}
			<UpdateNotices status={status} state={state} />
		</Section>
	);
}

export function UpdatesSection() {
	const status = useSyncExternalStore(
		subscribeUpdateStatus,
		getUpdateSnapshot,
		getUpdateServerSnapshot,
	);
	const [state, setState] = useState<ApplyState>({ phase: "idle" });
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [cliBusyId, setCliBusyId] = useState<string | null>(null);
	const [cliNotice, setCliNotice] = useState<string | null>(null);
	const [cliTerminal, setCliTerminal] = useState<{
		label: string;
		command: string;
		cwd: string;
		sessionId: string;
		initiallyCopied: boolean;
	} | null>(null);
	// Persists the version at launch time so the polling effect doesn't lose it
	// when status changes and the effect dependency re-evaluates.
	const launchingStartVersionRef = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		setFetchError(null);
		try {
			const res = await fetch("/api/updates");
			const j = (await res.json()) as { ok: boolean; data?: UpdateStatus };
			if (j.ok && j.data) setUpdateStatus(j.data);
		} catch (e) {
			console.error("[updates] fetch failed:", e);
			setFetchError(e instanceof Error ? e.message : "fetch failed");
		}
	}, []);

	useEffect(() => {
		if (status) return;
		void refresh();
	}, [refresh, status]);

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
		action: "check" | "download" | "apply" | "prepare_cli" | "apply_cli",
		extra: Record<string, unknown> = {},
	): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		const res = await fetch("/api/updates", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ...extra }),
		});
		return (await res.json()) as {
			ok: boolean;
			data?: unknown;
			error?: string;
		};
	}

	async function runCliUpdate(update: CliUpdateStatus) {
		const automatic = update.updateMode === "automatic";
		setCliBusyId(update.id);
		setCliNotice(null);
		const result: { ok: boolean; data?: unknown; error?: string } =
			await postAction(automatic ? "apply_cli" : "prepare_cli", {
				id: update.id,
			}).catch((error) => ({ ok: false, error: String(error) }));
		if (!result.ok) {
			setCliNotice(result.error ?? "Update failed");
			setCliBusyId(null);
			return;
		}
		if (automatic) {
			setCliNotice(`${update.label} updated. Rechecking installed versions…`);
			await refresh();
		} else {
			const data = result.data as
				| { command?: string; terminalCwd?: string }
				| undefined;
			const command = data?.command ?? update.updateCommand;
			const terminalCwd = data?.terminalCwd;
			if (!command || !terminalCwd) {
				setCliNotice("Update terminal details were incomplete");
				setCliBusyId(null);
				return;
			}
			let initiallyCopied = false;
			try {
				await navigator.clipboard.writeText(command);
				initiallyCopied = true;
			} catch {}
			setCliNotice("Provider sessions stopped and update terminal opened.");
			setCliTerminal({
				label: update.label,
				command,
				cwd: terminalCwd,
				sessionId: `cli-update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				initiallyCopied,
			});
		}
		setCliBusyId(null);
	}

	async function forceCheck(): Promise<string | null> {
		setState({ phase: "checking" });
		const r = await postAction("check").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (r.ok && r.data) {
			setUpdateStatus(r.data as UpdateStatus);
			setState({ phase: "idle" });
			return null;
		}
		const message = r.error ?? "check failed";
		setState({ phase: "error", message });
		return message;
	}

	async function checkNow() {
		await forceCheck();
	}

	async function closeCliTerminalAndRecheck() {
		setCliTerminal(null);
		setCliNotice("Update terminal closed. Rechecking installed versions…");
		const error = await forceCheck();
		setCliNotice(error ?? "Installed CLI versions refreshed.");
	}

	// Download + checksum-verify the new exe, then surface a "Launch" button.
	// We don't auto-launch because Windows SmartScreen only renders its
	// "More info → Run anyway" prompt when the launch comes from an
	// interactive shell context. Routing the server-held verified artifact
	// through `explorer.exe` on a user click is what gets the prompt
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
		const data = dl.data as { version: string } | undefined;
		if (!data?.version) {
			setState({
				phase: "error",
				message: "incomplete download response (missing version)",
			});
			return;
		}
		setState({
			phase: "downloaded",
			targetVersion: data.version,
		});
	}

	async function launchStaged(targetVersion: string) {
		launchingStartVersionRef.current = status?.current ?? null;
		setState({ phase: "launching", targetVersion });
		const ap = await postAction("apply").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!ap.ok) {
			setState({ phase: "error", message: ap.error ?? "launch failed" });
		}
		// On success the staged exe's maybeSelfInstall path will POST a
		// shutdown to the running canonical; the polling effect above
		// takes over and reloads when the new version answers.
	}

	return (
		<>
			<UpdatesView
				status={status}
				state={state}
				fetchError={fetchError}
				cliBusyId={cliBusyId}
				cliNotice={cliNotice}
				onRefresh={() => void refresh()}
				onCheck={() => void checkNow()}
				onDownload={() => void downloadOnly()}
				onLaunch={(version) => void launchStaged(version)}
				onCliUpdate={(update) => void runCliUpdate(update)}
			/>
			{status?.release && <LatestChanges release={status.release} />}
			{cliTerminal && (
				<CliUpdateTerminalModal
					{...cliTerminal}
					onClose={() => void closeCliTerminalAndRecheck()}
				/>
			)}
		</>
	);
}
