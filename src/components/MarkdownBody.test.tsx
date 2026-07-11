// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub MermaidBlock to avoid dynamic import of the mermaid library in jsdom.
vi.mock("./MermaidBlock", () => ({
	MermaidBlock: ({ code }: { code: string }) => (
		<div data-testid="mermaid-block">{code}</div>
	),
}));

// Mock highlight.js/lib/common — we test the wiring (lang detection, streaming
// skip, fallback to auto), not highlight.js itself.
vi.mock("highlight.js/lib/common", () => {
	const wrap = (cls: string, value: string) =>
		`<span class="hljs-${cls}">${value}</span>`;
	return {
		default: {
			getLanguage: (lang: string) =>
				["js", "ts", "py", "python"].includes(lang) ? { name: lang } : null,
			highlight: (code: string, opts: { language: string }) => ({
				value: wrap("kw", `${opts.language}:${code}`),
			}),
			highlightAuto: (code: string) => ({
				value: wrap("auto", code),
			}),
		},
	};
});

import { MarkdownBody } from "./MarkdownBody";

let consoleError: ReturnType<typeof vi.spyOn>;

afterEach(() => {
	cleanup();
	consoleError.mockRestore();
});

beforeEach(() => {
	consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
		throw new Error(`Unexpected console.error: ${args.join(" ")}`);
	});
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
});

describe("MarkdownBody", () => {
	describe("basic markdown", () => {
		it("renders headings, paragraphs, strong, emphasis", () => {
			render(
				<MarkdownBody
					content={"# Title\n\nSome **bold** and *italic* text."}
				/>,
			);
			expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
				"Title",
			);
			expect(screen.getByText("bold").tagName).toBe("STRONG");
			expect(screen.getByText("italic").tagName).toBe("EM");
		});

		it("renders inline code with subtle styling", () => {
			render(<MarkdownBody content={"Use `npm install` to install."} />);
			const code = screen.getByText("npm install");
			expect(code.tagName).toBe("CODE");
			// inline code does NOT use the block class
			expect(code.className).not.toContain("block");
		});

		it("renders links with target=_blank and rel=noreferrer", () => {
			render(<MarkdownBody content={"[example](https://example.com)"} />);
			const link = screen.getByRole("link", { name: "example" });
			expect(link.getAttribute("href")).toBe("https://example.com");
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noreferrer");
		});

		it("renders GFM tables", () => {
			render(<MarkdownBody content={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
			expect(screen.getByRole("table")).toBeTruthy();
			expect(screen.getByRole("columnheader", { name: "a" })).toBeTruthy();
			expect(screen.getByRole("cell", { name: "1" })).toBeTruthy();
		});

		it("renders strikethrough via GFM", () => {
			render(<MarkdownBody content={"~~gone~~"} />);
			expect(screen.getByText("gone").tagName).toBe("DEL");
		});
	});

	describe("code blocks", () => {
		it("renders fenced code with language label and code text", () => {
			render(<MarkdownBody content={"```ts\nconst x = 1;\n```"} />);
			expect(screen.getByText("ts")).toBeTruthy();
			expect(screen.getByText("const x = 1;")).toBeTruthy();
		});

		it("falls back to 'text' label for fences with no language", () => {
			render(<MarkdownBody content={"```\nplain code\n```"} />);
			expect(screen.getByText("text")).toBeTruthy();
			expect(screen.getByText("plain code")).toBeTruthy();
		});

		it("renders a copy button on code blocks", () => {
			render(<MarkdownBody content={"```js\nfoo();\n```"} />);
			expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
		});

		it("clicking copy writes the raw code to the clipboard", () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, "clipboard", {
				value: { writeText },
				configurable: true,
			});
			render(<MarkdownBody content={"```py\nprint('hi')\n```"} />);
			fireEvent.click(screen.getByRole("button", { name: /copy/i }));
			expect(writeText).toHaveBeenCalledWith("print('hi')");
		});

		it("copy button is visible on touch devices via [@media(hover:none)]", () => {
			render(<MarkdownBody content={"```\nx\n```"} />);
			const btn = screen.getByRole("button", { name: /copy/i });
			expect(btn.className).toContain("[@media(hover:none)]:opacity-100");
		});

		it("does not render a copy button for inline code", () => {
			render(<MarkdownBody content={"some `inline` text"} />);
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		});
	});

	describe("syntax highlighting", () => {
		// findBy* waits for the highlight effect (which lazy-loads + sets state).
		it("uses the declared language when known to highlight.js", async () => {
			const { container } = render(
				<MarkdownBody content={"```ts\nlet x = 1;\n```"} />,
			);
			const codeEl = await screen.findByText(/ts:let x = 1;/);
			expect(codeEl.className).toContain("hljs-kw");
			const code = container.querySelector("code");
			expect(code?.getAttribute("data-highlighted")).toBe("true");
		});

		it("falls back to auto-detect when language is not in the bundle", async () => {
			const { container } = render(
				<MarkdownBody content={"```rust\nfn main() {}\n```"} />,
			);
			await screen.findByText(
				(_, el) => el?.classList.contains("hljs-auto") ?? false,
			);
			const span = container.querySelector(".hljs-auto");
			expect(span?.textContent).toBe("fn main() {}");
		});

		it("uses auto-detect when no language is declared", async () => {
			const { container } = render(
				<MarkdownBody content={"```\nplain code\n```"} />,
			);
			await screen.findByText(
				(_, el) => el?.classList.contains("hljs-auto") ?? false,
			);
			const span = container.querySelector(".hljs-auto");
			expect(span?.textContent).toBe("plain code");
		});

		it("skips highlighting while streaming", async () => {
			const { container } = render(
				<MarkdownBody content={"```ts\nlet x = 1;\n```"} streaming />,
			);
			// Wait a frame so any effect would have run.
			await new Promise((r) => setTimeout(r, 0));
			const code = container.querySelector("code");
			expect(code?.getAttribute("data-highlighted")).toBeNull();
			// Raw text remains, no highlight spans inserted.
			expect(code?.querySelector(".hljs-kw")).toBeNull();
			expect(code?.textContent).toBe("let x = 1;");
		});

		it("re-highlights after streaming flips false (effect re-runs on prop change)", async () => {
			const { container, rerender } = render(
				<MarkdownBody content={"```ts\nlet x = 1;\n```"} streaming />,
			);
			await new Promise((r) => setTimeout(r, 0));
			expect(
				container.querySelector("code")?.getAttribute("data-highlighted"),
			).toBeNull();

			rerender(
				<MarkdownBody content={"```ts\nlet x = 1;\n```"} streaming={false} />,
			);
			await screen.findByText(/ts:let x = 1;/);
			expect(
				container.querySelector("code")?.getAttribute("data-highlighted"),
			).toBe("true");
		});
	});

	describe("mermaid", () => {
		it("routes mermaid fences to MermaidBlock instead of CodeBlock", () => {
			render(<MarkdownBody content={"```mermaid\ngraph TD; A-->B\n```"} />);
			const block = screen.getByTestId("mermaid-block");
			expect(block).toBeTruthy();
			expect(block.textContent).toContain("graph TD");
			// no copy button or code label for mermaid
			expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
			expect(screen.queryByText("mermaid")).toBeNull();
		});
	});

	describe("math (KaTeX)", () => {
		it("renders inline math", () => {
			const { container } = render(
				<MarkdownBody content={"Inline $a^2 + b^2 = c^2$ here."} />,
			);
			expect(container.querySelector(".katex")).toBeTruthy();
		});

		it("renders block math", () => {
			const { container } = render(
				<MarkdownBody content={"$$\n\\int_0^1 x \\, dx\n$$"} />,
			);
			expect(container.querySelector(".katex-display")).toBeTruthy();
		});
	});

	describe("highlight + emoji + raw HTML", () => {
		it("converts ==text== to a <mark>", () => {
			render(<MarkdownBody content={"==important=="} />);
			expect(screen.getByText("important").tagName).toBe("MARK");
		});

		it("converts gemoji shortcodes to unicode", () => {
			render(<MarkdownBody content={":rocket: launch"} />);
			expect(screen.getByText(/🚀\s*launch/)).toBeTruthy();
		});

		it("renders raw <details>/<summary>", () => {
			const { container } = render(
				<MarkdownBody
					content={"<details><summary>tap</summary>hidden</details>"}
				/>,
			);
			const details = container.querySelector("details");
			expect(details).toBeTruthy();
			expect(details?.querySelector("summary")?.textContent).toBe("tap");
		});

		it("renders raw <u> tags", () => {
			const { container } = render(
				<MarkdownBody content={"<u>underlined</u>"} />,
			);
			expect(container.querySelector("u")?.textContent).toBe("underlined");
		});

		it("strips <script> tags via sanitize", () => {
			const { container } = render(
				<MarkdownBody content={"safe<script>alert('xss')</script>after"} />,
			);
			expect(container.querySelector("script")).toBeNull();
			expect(container.textContent).toContain("safe");
			expect(container.textContent).toContain("after");
			expect(container.textContent).not.toContain("alert");
		});

		it("renders GitHub-style alert callouts", () => {
			const { container } = render(
				<MarkdownBody
					content={"> [!NOTE]\n> heads up\n\n> [!WARNING]\n> careful"}
				/>,
			);
			const note = container.querySelector(".markdown-alert-note");
			const warn = container.querySelector(".markdown-alert-warning");
			expect(note).toBeTruthy();
			expect(warn).toBeTruthy();
			expect(note?.textContent).toContain("heads up");
			expect(warn?.textContent).toContain("careful");
		});

		it("preserves alert SVG icons through sanitize", () => {
			const { container } = render(
				<MarkdownBody content={"> [!TIP]\n> useful"} />,
			);
			const svg = container.querySelector(".markdown-alert-tip svg");
			expect(svg).toBeTruthy();
		});

		// Regression: the custom `p` renderer used to drop the incoming className,
		// which stripped `markdown-alert-title` from the title <p> and broke the
		// icon's `currentColor` resolution.
		it("keeps the markdown-alert-title class on the alert title <p>", () => {
			const { container } = render(
				<MarkdownBody content={"> [!WARNING]\n> careful"} />,
			);
			const title = container.querySelector(
				".markdown-alert-warning .markdown-alert-title",
			);
			expect(title).toBeTruthy();
			expect(title?.tagName).toBe("P");
			// Custom renderer's classes also still applied.
			expect(title?.className).toContain("markdown-alert-title");
			expect(title?.className).toContain("mb-3");
		});

		it("strips on* event handler attributes", () => {
			const { container } = render(
				<MarkdownBody
					content={
						"<details onclick=\"alert('x')\"><summary>t</summary>b</details>"
					}
				/>,
			);
			const details = container.querySelector("details");
			expect(details).toBeTruthy();
			expect(details?.getAttribute("onclick")).toBeNull();
		});
	});

	describe("images", () => {
		it("renders markdown images as clickable buttons that open viewer modal", () => {
			render(
				<MarkdownBody content={"![a cat](https://example.com/cat.png)"} />,
			);
			const img = screen.getByRole("img", { name: "a cat" });
			expect(img).toBeDefined();
			// ClickableImage wraps img in a button with aria-label "View a cat"
			const btn = screen.getByRole("button", { name: /view a cat/i });
			expect(btn).toBeDefined();
			fireEvent.click(btn);
			expect(screen.getByRole("dialog")).toBeDefined();
		});
	});
});
