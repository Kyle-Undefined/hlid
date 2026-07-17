import { useEffect, useId, useRef, useState } from "react";

// Lazy-loaded; mermaid is ~700KB. Browser-only (uses DOM).
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
			mermaid.initialize({
				startOnLoad: false,
				// Per-diagram theme is injected via the `%%{init: ...}%%` directive
				// below; this is just the global default.
				theme: "default",
				// strict: mermaid sanitizes user-provided text before SVG generation,
				// so the SVG output below is safe to mount.
				securityLevel: "strict",
				fontFamily: "inherit",
			});
			return mermaid;
		});
	}
	return mermaidPromise;
}

function getActiveTheme(): "dark" | "default" {
	if (typeof document === "undefined") return "dark";
	const t = document.documentElement.getAttribute("data-theme");
	if (t === "tan") return "default";
	if (t === "custom") {
		return getComputedStyle(document.documentElement).colorScheme === "light"
			? "default"
			: "dark";
	}
	return "dark";
}

export function MermaidBlock({ code }: { code: string }) {
	const id = useId().replace(/[^a-zA-Z0-9]/g, "");
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(true);
	const [themeTick, setThemeTick] = useState(0);

	// Re-render when the host page swaps themes.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;
		setPending(true);
		const theme = getActiveTheme();
		// Per-diagram init directive overrides the global theme — lets us swap
		// dark/light without re-initializing mermaid (which would invalidate other
		// diagrams already rendered).
		const themed = `%%{init: {'theme':'${theme}'}}%%\n${code}`;
		loadMermaid()
			.then((mermaid) => mermaid.render(`m${id}-${themeTick}`, themed))
			.then(({ svg }) => {
				if (cancelled || !containerRef.current) return;
				// Parse SVG string into a DOM node and mount via replaceChildren —
				// avoids raw HTML APIs. mermaid's strict mode has already sanitized
				// the diagram source.
				const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
				const root = parsed.documentElement;
				if (root.nodeName === "parsererror") {
					setError("invalid SVG from mermaid");
					setPending(false);
					return;
				}
				containerRef.current.replaceChildren(root);
				setError(null);
				setPending(false);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setError(e instanceof Error ? e.message : "mermaid render failed");
				setPending(false);
			});
		return () => {
			cancelled = true;
		};
	}, [code, id, themeTick]);

	if (error) {
		return (
			<pre className="block bg-secondary/60 border border-destructive/40 px-3 py-2 text-xs font-mono text-destructive overflow-x-auto whitespace-pre mb-3">
				mermaid error: {error}
				{"\n\n"}
				{code}
			</pre>
		);
	}

	return (
		<div
			ref={containerRef}
			className="mermaid-block mb-3 flex justify-center bg-secondary/30 border border-border rounded p-3 overflow-x-auto"
			data-pending={pending ? "true" : undefined}
		/>
	);
}
