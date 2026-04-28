import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownBody({ content }: { content: string }) {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
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
					const isBlock = /language-/.test(className ?? "");
					return isBlock ? (
						<code className="block bg-secondary/60 border border-border px-3 py-2 text-xs font-mono text-foreground/90 overflow-x-auto whitespace-pre mb-3">
							{children}
						</code>
					) : (
						<code className="bg-secondary/80 px-1.5 py-0.5 text-[11px] font-mono text-primary/80">
							{children}
						</code>
					);
				},
				pre: ({ children }) => <pre className="mb-3">{children}</pre>,
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
					<strong className="font-semibold text-foreground">{children}</strong>
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
			}}
		>
			{content}
		</Markdown>
	);
}
