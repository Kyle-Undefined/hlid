import { useEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { CopyButton } from "./chat/CopyButton";

// highlight.js/lib/common bundles ~30 popular languages instead of the full
// ~190 — drops payload from ~600KB to ~80KB. Lazy-loaded so non-code messages
// pay nothing.
let hljsPromise: Promise<typeof import("highlight.js").default> | null = null;
function loadHljs() {
	if (!hljsPromise) {
		hljsPromise = import("highlight.js/lib/common").then((m) => m.default);
	}
	return hljsPromise;
}

export function CodeBlock({
	code,
	language,
	streaming = false,
}: {
	code: string;
	language: string | null;
	streaming?: boolean;
}) {
	const { copy, copied } = useCopyToClipboard();
	const codeRef = useRef<HTMLElement>(null);
	const [highlighted, setHighlighted] = useState(false);

	useEffect(() => {
		// Skip highlight while streaming — re-running on every token thrashes.
		// Plain text shows immediately; final highlight runs once streaming ends.
		if (streaming) {
			setHighlighted(false);
			return;
		}
		let cancelled = false;
		loadHljs()
			.then((hljs) => {
				if (cancelled || !codeRef.current) return;
				const lang = language && hljs.getLanguage(language) ? language : null;
				const result = lang
					? hljs.highlight(code, { language: lang, ignoreIllegals: true })
					: hljs.highlightAuto(code);
				// highlight.js output is generated from our (HTML-escaped) text
				// input — no untrusted markup. Parse into nodes and mount via
				// replaceChildren to keep React happy and avoid raw HTML APIs.
				const parser = new DOMParser();
				const doc = parser.parseFromString(
					`<div>${result.value}</div>`,
					"text/html",
				);
				const root = doc.body.firstElementChild;
				if (!root) return;
				codeRef.current.replaceChildren(...Array.from(root.childNodes));
				setHighlighted(true);
			})
			.catch(() => {
				// Highlight failed; leave plain text in place.
			});
		return () => {
			cancelled = true;
		};
	}, [code, language, streaming]);

	return (
		<div className="mb-3 border border-border bg-secondary/60 group/code">
			<div className="flex items-center justify-between px-3 py-1 border-b border-border bg-secondary/40">
				<span className="text-[10px] font-mono tracking-wider text-muted-foreground/70 uppercase">
					{language ?? "text"}
				</span>
				<CopyButton
					onCopy={() => copy(code)}
					copied={copied}
					className="opacity-0 group-hover/code:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
				/>
			</div>
			<pre className="px-3 py-2 overflow-x-auto">
				<code
					ref={codeRef}
					className={`hljs text-xs font-mono text-foreground/90 whitespace-pre ${
						language ? `language-${language}` : ""
					}`}
					data-highlighted={highlighted ? "true" : undefined}
				>
					{code}
				</code>
			</pre>
		</div>
	);
}
