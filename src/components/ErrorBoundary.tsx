import { Component, type ReactNode } from "react";
import { logClientErrorFn } from "#/lib/serverFns";

// ─── Shared fallback UI ───────────────────────────────────────────────────────

export function ErrorFallback({
	error,
	reset,
}: {
	error: Error;
	reset?: () => void;
}) {
	return (
		<div
			role="alert"
			className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center"
		>
			<p className="text-[9px] tracking-widest uppercase text-destructive/70">
				error
			</p>
			<p className="text-xs text-muted-foreground max-w-xs break-words">
				{error.message}
			</p>
			{reset && (
				<button
					type="button"
					onClick={reset}
					aria-label="Retry loading"
					className="text-[9px] tracking-widest uppercase text-muted-foreground/50 hover:text-muted-foreground transition-colors"
				>
					retry
				</button>
			)}
		</div>
	);
}

// ─── Class boundary ───────────────────────────────────────────────────────────

type Props = {
	children: ReactNode;
	/** Custom fallback. If omitted, renders ErrorFallback with a reset button. */
	fallback?: ReactNode;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: { componentStack: string }) {
		console.error("[ErrorBoundary]", error, info.componentStack);
		// Best-effort: ship to server event log so mobile PWA users don't need devtools.
		// Use error.name (e.g. "TypeError") rather than message to avoid leaking
		// sensitive data (file paths, tokens, DB strings) that may appear in messages.
		void logClientErrorFn({
			data: { errorName: error.name, componentStack: info.componentStack },
		}).catch(() => {});
	}

	reset = () => this.setState({ error: null });

	render() {
		if (this.state.error) {
			return (
				this.props.fallback ?? (
					<ErrorFallback error={this.state.error} reset={this.reset} />
				)
			);
		}
		return this.props.children;
	}
}
