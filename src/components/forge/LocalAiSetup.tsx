import { useCallback, useEffect, useState } from "react";
import type {
	LocalAiSetupSnapshot,
	LocalAiSetupStep,
} from "#/lib/localAiSetup";
import {
	getLocalAiSetupFn,
	mutateLocalAiSetupFn,
} from "#/lib/serverFns/localAiSetup";

const STATUS_LABEL: Record<LocalAiSetupStep["status"], string> = {
	ready: "Ready",
	"needs-action": "Needs attention",
	"not-needed": "Not needed",
	unknown: "Check status",
};

const STATUS_CLASS: Record<LocalAiSetupStep["status"], string> = {
	ready: "text-status-success",
	"needs-action": "text-status-warning",
	"not-needed": "text-muted-foreground",
	unknown: "text-status-warning",
};

export function LocalAiSetup({
	onOpenOllama,
	onOpenOpenCode,
}: {
	onOpenOllama: () => void;
	onOpenOpenCode: () => void;
}) {
	const [snapshot, setSnapshot] = useState<LocalAiSetupSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			setSnapshot(await getLocalAiSetupFn());
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not refresh local AI setup.",
			);
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function mutate(action: "start" | "acknowledge", step?: string) {
		setBusy(true);
		setError(null);
		try {
			setSnapshot(
				await mutateLocalAiSetupFn({
					data:
						action === "start"
							? { action }
							: { action, step: step as LocalAiSetupStep["id"] },
				}),
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save local AI setup progress.",
			);
		} finally {
			setBusy(false);
		}
	}

	function openOwner(action: LocalAiSetupStep["action"]) {
		if (action === "opencode") onOpenOpenCode();
		if (action === "ollama") onOpenOllama();
	}

	return (
		<section
			aria-labelledby="local-ai-setup-title"
			className="min-w-0 space-y-3 border border-primary/25 bg-primary/5 px-3 py-3"
		>
			<div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 id="local-ai-setup-title" className="text-xs text-foreground/80">
						Guided local AI setup
					</h3>
					<p className="break-words text-[10px] text-muted-foreground">
						This remembers only your setup intent and reviewed steps. Every live
						status is checked again when you return; it never installs software,
						changes a firewall, downloads a model, or deletes anything.
					</p>
				</div>
				<button
					type="button"
					disabled={busy}
					onClick={() => void refresh()}
					className="shrink-0 text-[10px] text-primary hover:underline disabled:text-muted-foreground"
				>
					{busy ? "Checking…" : "Refresh live status"}
				</button>
			</div>

			{error && <p className="text-[10px] text-status-error">{error}</p>}
			{!snapshot ? (
				<p className="text-[10px] text-muted-foreground">
					Checking local setup…
				</p>
			) : !snapshot.intent ? (
				<button
					type="button"
					disabled={busy}
					onClick={() => void mutate("start")}
					className="border border-primary/50 px-3 py-1.5 text-[10px] text-primary disabled:border-border disabled:text-muted-foreground"
				>
					Start guided setup
				</button>
			) : (
				<ol className="space-y-2">
					{snapshot.steps.map((item) => (
						<li
							key={item.id}
							className="flex min-w-0 flex-col gap-1 border border-border/70 px-2 py-2 @2xl:flex-row @2xl:items-center @2xl:justify-between"
						>
							<div className="min-w-0 text-[10px]">
								<div className="flex flex-wrap gap-x-2">
									<span className="text-foreground/80">{item.title}</span>
									<span className={STATUS_CLASS[item.status]}>
										{STATUS_LABEL[item.status]}
									</span>
								</div>
								<p className="break-words text-[9px] text-muted-foreground">
									{item.description}
								</p>
							</div>
							<div className="flex shrink-0 flex-wrap items-center gap-2 text-[9px]">
								{item.action && (
									<button
										type="button"
										onClick={() => openOwner(item.action)}
										className="text-primary hover:underline"
									>
										{item.action === "ollama" ? "Open Ollama" : "Open OpenCode"}
									</button>
								)}
								{!item.acknowledged && (
									<button
										type="button"
										disabled={busy}
										onClick={() => void mutate("acknowledge", item.id)}
										className="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/50"
									>
										Mark reviewed
									</button>
								)}
							</div>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
