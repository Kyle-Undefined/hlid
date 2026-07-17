import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "#/hooks/useDialogFocus";
import { PlanDecisionBar } from "./PlanDecisionBar";

type DecisionProps = {
	readOnly?: false;
	feedback: string;
	onFeedbackChange: (value: string) => void;
	onCancel: () => void;
	onApprove: () => void;
	onRevise: () => void;
};

type ReadOnlyProps = {
	readOnly: true;
};

/**
 * Full-screen modal hosting the agent-authored HTML plan document in a
 * sandboxed iframe (opaque origin — no `allow-same-origin` — so the plan's
 * own scripts can never reach hlid cookies or APIs). Decision controls live
 * in the footer for pending proposals; resolved proposals open read-only.
 */
export function PlanHtmlModal({
	relicId,
	onClose,
	...decision
}: {
	relicId: string;
	onClose: () => void;
} & (DecisionProps | ReadOnlyProps)) {
	const { dialogRef, onDialogKeyDown } =
		useDialogFocus<HTMLDivElement>(onClose);
	const [html, setHtml] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const load = async () => {
			for (
				let attempt = 0;
				attempt < 5 && !controller.signal.aborted;
				attempt++
			) {
				try {
					const response = await fetch(`/api/attachments/${relicId}/raw`, {
						cache: "no-store",
						credentials: "same-origin",
						signal: controller.signal,
					});
					if (response.ok) {
						const body = await response.text();
						const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:">`;
						setHtml(`${csp}${body}`);
						setLoadError(false);
						return;
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					if (attempt === 4) console.warn("Plan HTML load failed:", error);
				}
				if (attempt < 4) {
					await new Promise<void>((resolve) => {
						retryTimer = setTimeout(resolve, 150 * (attempt + 1));
					});
				}
			}
			if (!controller.signal.aborted) setLoadError(true);
		};
		void load();
		return () => {
			controller.abort();
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [relicId]);

	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop Escape handled by inner dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop pattern
		<div
			className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Plan document"
				className="relative flex flex-col w-[92vw] max-w-5xl max-h-[90vh] bg-card border border-border shadow-2xl focus:outline-none"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={onDialogKeyDown}
			>
				<div className="flex items-center justify-between px-4 py-2 border-b border-border">
					<span className="text-[9px] tracking-widest text-muted-foreground/65 uppercase">
						{decision.readOnly ? "PLAN" : "PROPOSED PLAN (HTML)"}
					</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close plan viewer"
						className="text-muted-foreground hover:text-foreground transition-colors p-1"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
				{html ? (
					<iframe
						srcDoc={html}
						title="Plan document"
						sandbox="allow-scripts"
						referrerPolicy="no-referrer"
						className="w-full h-[70vh] bg-white border-0"
					/>
				) : (
					<div className="w-full h-[70vh] bg-white text-black/60 flex items-center justify-center text-xs tracking-widest uppercase">
						{loadError ? "Plan document unavailable" : "Loading plan…"}
					</div>
				)}
				{!decision.readOnly && (
					<PlanDecisionBar
						feedback={decision.feedback}
						onFeedbackChange={decision.onFeedbackChange}
						onCancel={() => {
							decision.onCancel();
							onClose();
						}}
						onApprove={() => {
							decision.onApprove();
							onClose();
						}}
						onRevise={() => {
							decision.onRevise();
							onClose();
						}}
					/>
				)}
			</div>
		</div>,
		document.body,
	);
}
