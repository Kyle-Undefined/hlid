import "katex/dist/katex.min.css";
import { memo } from "react";
import Markdown, { type Options } from "react-markdown";
import { ClickableImage } from "./ImageViewerModal";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import { remarkMark } from "remark-mark-highlight";
import remarkMath from "remark-math";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";

// Sanitize before katex: user-supplied HTML is filtered, then katex generates
// trusted output that bypasses sanitize. Allows <details>/<summary> and the
// math-* class names produced by remark-math so katex can pick them up.
const ALERT_CLASSES = [
	"markdown-alert",
	"markdown-alert-note",
	"markdown-alert-tip",
	"markdown-alert-important",
	"markdown-alert-warning",
	"markdown-alert-caution",
];

const sanitizeSchema = {
	...defaultSchema,
	tagNames: [
		...(defaultSchema.tagNames ?? []),
		"details",
		"summary",
		"mark",
		"u",
		// remark-github-blockquote-alert emits an inline octicon SVG per alert.
		"svg",
		"path",
	],
	attributes: {
		...defaultSchema.attributes,
		span: [
			...(defaultSchema.attributes?.span ?? []),
			["className", "math", "math-inline", "math-display"],
		],
		div: [
			...(defaultSchema.attributes?.div ?? []),
			["className", "math", "math-inline", "math-display", ...ALERT_CLASSES],
		],
		p: [
			...(defaultSchema.attributes?.p ?? []),
			["className", "markdown-alert-title"],
		],
		details: ["open"],
		svg: [
			"viewBox",
			"width",
			"height",
			"fill",
			"ariaHidden",
			"className",
			"version",
			"xmlns",
		],
		path: ["d", "fill", "fillRule", "clipRule"],
	},
};

const remarkPlugins: Options["remarkPlugins"] = [
	remarkGfm,
	remarkMath,
	remarkGemoji,
	remarkMark,
	remarkAlert,
];
const rehypePlugins: Options["rehypePlugins"] = [
	rehypeRaw,
	[rehypeSanitize, sanitizeSchema],
	rehypeKatex,
];

export const MarkdownBody = memo(function MarkdownBody({
	content,
	streaming = false,
}: {
	content: string;
	streaming?: boolean;
}) {
	return (
		<Markdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			components={{
				p: ({ children, className }) => (
					<p
						className={
							className ? `${className} mb-3 last:mb-0` : "mb-3 last:mb-0"
						}
					>
						{children}
					</p>
				),
				h1: ({ children }) => (
					<h1 className="text-base font-bold mb-2 mt-4 first:mt-0">
						{children}
					</h1>
				),
				h2: ({ children }) => (
					<h2 className="text-sm font-bold mb-2 mt-4 first:mt-0 tracking-wide">
						{children}
					</h2>
				),
				h3: ({ children }) => (
					<h3 className="text-sm font-semibold mb-1.5 mt-3 first:mt-0">
						{children}
					</h3>
				),
				ul: ({ children }) => (
					<ul className="list-disc pl-5 mb-3 space-y-0.5">{children}</ul>
				),
				ol: ({ children }) => (
					<ol className="list-decimal pl-5 mb-3 space-y-0.5">{children}</ol>
				),
				li: ({ children }) => <li className="leading-relaxed">{children}</li>,
				code: ({ children, className }) => {
					const lang = className?.startsWith("language-")
						? className.slice("language-".length)
						: null;
					const text = typeof children === "string" ? children : null;
					if (lang === "mermaid" && text !== null) {
						return <MermaidBlock code={text.trimEnd()} />;
					}
					const isBlock = lang !== null || text?.includes("\n");
					if (isBlock && text !== null) {
						return (
							<CodeBlock
								code={text.replace(/\n$/, "")}
								language={lang}
								streaming={streaming}
							/>
						);
					}
					return (
						<code className="bg-secondary/80 px-1.5 py-0.5 text-[11px] font-mono text-primary/80 rounded-none">
							{children}
						</code>
					);
				},
				// CodeBlock + MermaidBlock provide their own wrappers — pre passes through.
				pre: ({ children }) => <>{children}</>,
				blockquote: ({ children }) => (
					<blockquote className="border-l-2 border-primary/30 pl-3 text-foreground/75 italic mb-3">
						{children}
					</blockquote>
				),
				a: ({ href, children }) => (
					<a
						href={href}
						className="text-primary underline underline-offset-2 hover:text-primary/80"
						target="_blank"
						rel="noreferrer"
					>
						{children}
					</a>
				),
				strong: ({ children }) => (
					<strong className="font-semibold text-current">{children}</strong>
				),
				hr: () => <hr className="border-border my-3" />,
				table: ({ children }) => (
					<div className="overflow-x-auto mb-3">
						<table className="text-xs w-full border-collapse">{children}</table>
					</div>
				),
				th: ({ children }) => (
					<th className="border border-border px-3 py-1.5 text-left text-[10px] tracking-wider text-muted-foreground bg-secondary/40">
						{children}
					</th>
				),
				td: ({ children }) => (
					<td className="border border-border px-3 py-1.5">{children}</td>
				),
				mark: ({ children }) => (
					<mark className="bg-primary/25 text-foreground px-0.5 rounded-sm">
						{children}
					</mark>
				),
				img: ({ src, alt }) => (
					<ClickableImage src={src ?? ""} alt={alt ?? ""} />
				),
				u: ({ children }) => (
					<u className="underline underline-offset-2 decoration-foreground/60">
						{children}
					</u>
				),
				details: ({ children }) => (
					<details className="border border-border rounded px-3 py-2 mb-3 bg-secondary/30">
						{children}
					</details>
				),
				summary: ({ children }) => (
					<summary className="cursor-pointer font-medium text-foreground/90">
						{children}
					</summary>
				),
			}}
		>
			{content}
		</Markdown>
	);
});
