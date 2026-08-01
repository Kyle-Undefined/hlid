import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	lstat,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import * as vm from "node:vm";

export const WINDOWS_VISUALIZE_MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;
export const WINDOWS_VISUALIZE_MAX_JOB_ENTRIES = 4_096;
export const WINDOWS_VISUALIZE_MAX_JOB_DEPTH = 32;

const DIRECTIVE_PREFIX = "::codex-inline-vis{";
const DIRECTIVE_PATTERN =
	/^::codex-inline-vis\{file="([a-z0-9]+(?:-[a-z0-9]+)*\.html)"\}$/;
const DOCUMENT_WRAPPER_PATTERN =
	/<\s*!doctype(?=[\s>])|<\s*\/?\s*(?:html|head|body)(?=[\s>])/i;
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_ATTRIBUTE_PATTERN =
	/([^\t\n\f />"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CLASSIC_SCRIPT_TYPES = new Set([
	"",
	"application/ecmascript",
	"application/javascript",
	"text/ecmascript",
	"text/javascript",
]);
const MOBILE_SCROLL_POLICY = `<style data-hlid-mobile-scroll-policy>
@media (hover: none) and (pointer: coarse) {
  html,
  body,
  body * {
    touch-action: pan-x pan-y pinch-zoom !important;
  }

  html,
  body {
    -webkit-overflow-scrolling: touch;
  }
}
</style>`;
const VISUALIZATION_ZOOM_RECEIVER = `<script data-hlid-visualization-zoom-receiver>
(() => {
  const MESSAGE_TYPE = "hlid:visualization-zoom";
  const root = document.documentElement;
  const originalTransform = root.style.transform;
  const originalTransformOrigin = root.style.transformOrigin;
  addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== parent ||
      !data ||
      data.type !== MESSAGE_TYPE ||
      data.version !== 1 ||
      typeof data.zoom !== "number" ||
      !Number.isFinite(data.zoom) ||
      data.zoom < 0.5 ||
      data.zoom > 1.5
    ) return;
    if (data.zoom === 1) {
      root.style.transform = originalTransform;
      root.style.transformOrigin = originalTransformOrigin;
      return;
    }
    root.style.transform = originalTransform
      ? originalTransform + " scale(" + data.zoom + ")"
      : "scale(" + data.zoom + ")";
    root.style.transformOrigin = "0 0";
  });
  document.currentScript?.remove();
})();
</script>`;

export type WindowsVisualizeArtifact = {
	filename: string;
	sourcePath: string;
	validatedSha256: string;
};

function scriptAttributes(attributes: string): Map<string, string> {
	const parsed = new Map<string, string>();
	for (const match of attributes.matchAll(SCRIPT_ATTRIBUTE_PATTERN)) {
		const name = match[1]?.toLowerCase();
		if (!name || parsed.has(name)) continue;
		parsed.set(name, match[2] ?? match[3] ?? match[4] ?? "");
	}
	return parsed;
}

function validateClassicScript(source: string, index: number): void {
	try {
		const script = new vm.Script(source, {
			filename: `windows-visualize-inline-${index}.js`,
		});
		// Bun defers parsing until compilation work is requested. Cached bytecode
		// forces that work without evaluating the worker-authored script.
		script.createCachedData();
	} catch (error) {
		throw new Error(
			`Windows Visualize inline script ${index} has invalid JavaScript syntax`,
			{ cause: error },
		);
	}
}

async function validateModuleScript(
	source: string,
	index: number,
): Promise<void> {
	const SourceTextModule = vm.SourceTextModule;
	// The ordinary Vitest lane runs under Node without experimental VM modules.
	// Hlid itself and the dedicated Bun regression lane both take this path.
	if (typeof SourceTextModule !== "function") return;

	let dependencyIndex = 0;
	try {
		const module = new SourceTextModule(source, {
			identifier: `windows-visualize-inline-${index}.mjs`,
		});
		// Returning a harmless module lets Bun parse the complete source before
		// graph linking. Throwing from the linker stops Bun at the first import and
		// can hide a syntax error later in the visualization script.
		await module.link(() => {
			dependencyIndex += 1;
			return new SourceTextModule("export default undefined;", {
				identifier: `windows-visualize-dependency-${index}-${dependencyIndex}.mjs`,
			});
		});
	} catch (error) {
		// The browser owns approved CDN modules, so the local parse stub cannot
		// know their named exports. Bun reports that graph mismatch only after the
		// complete source has parsed successfully.
		if (
			error instanceof Error &&
			/export named .+ not found in module/i.test(error.message)
		) {
			return;
		}
		throw new Error(
			`Windows Visualize inline script ${index} has invalid JavaScript syntax`,
			{ cause: error },
		);
	}
}

/**
 * Parse executable inline scripts without evaluating them so a worker cannot
 * hand Raven a visualization whose static markup renders while every
 * interaction is dead because of one JavaScript syntax error.
 */
export async function validateWindowsVisualizeInlineScripts(
	fragment: string,
): Promise<void> {
	let inlineScriptIndex = 0;
	for (const match of fragment.matchAll(INLINE_SCRIPT_PATTERN)) {
		const attributes = scriptAttributes(match[1] ?? "");
		if (attributes.has("src")) continue;

		const type = (attributes.get("type") ?? "").trim().toLowerCase();
		if (!CLASSIC_SCRIPT_TYPES.has(type) && type !== "module") continue;

		inlineScriptIndex += 1;
		const source = match[2] ?? "";
		if (type === "module") {
			await validateModuleScript(source, inlineScriptIndex);
		} else {
			validateClassicScript(source, inlineScriptIndex);
		}
	}
}

/**
 * Add the host-side mobile gesture policy after agent-authored styles so a
 * dominant drag surface cannot trap the Raven scroller on touch devices.
 */
export function applyWindowsVisualizeMobileScrollPolicy(
	fragment: string,
): string {
	return `${fragment.trimEnd()}\n${MOBILE_SCROLL_POLICY}\n`;
}

/** Add the receiver that applies Hlid's bounded zoom inside the sandbox. */
export function applyWindowsVisualizeZoomReceiver(fragment: string): string {
	return `${fragment.trimEnd()}\n${VISUALIZATION_ZOOM_RECEIVER}\n`;
}

function extractDirectiveFilename(text: string): string {
	const prefixCount = text.split(DIRECTIVE_PREFIX).length - 1;
	const matches = text
		.split(/\r?\n/)
		.map((line) => DIRECTIVE_PATTERN.exec(line.trim()))
		.filter((match): match is RegExpExecArray => match !== null);

	if (prefixCount !== 1 || matches.length !== 1) {
		throw new Error(
			"Windows Visualize worker must return exactly one standalone ::codex-inline-vis directive",
		);
	}

	const filename = matches[0]?.[1];
	if (!filename) {
		throw new Error("Windows Visualize directive is missing a filename");
	}
	return filename;
}

function isContained(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child !== "" &&
		!isAbsolute(child) &&
		child !== ".." &&
		!child.startsWith(`..${sep}`)
	);
}

async function readValidatedFragment(
	sourcePath: string,
	maxBytes: number,
	options: { validateScripts?: boolean } = {},
): Promise<{ fragment: string; sha256: string }> {
	const bytes = await readFile(sourcePath);
	if (bytes.byteLength > maxBytes) {
		throw new Error(
			`Windows Visualize fragment exceeds the ${maxBytes} byte limit`,
		);
	}

	let fragment: string;
	try {
		fragment = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error("Windows Visualize fragment must be valid UTF-8", {
			cause: error,
		});
	}
	if (DOCUMENT_WRAPPER_PATTERN.test(fragment)) {
		throw new Error(
			"Windows Visualize fragment must not contain document, html, head, or body wrappers",
		);
	}
	if (options.validateScripts !== false) {
		await validateWindowsVisualizeInlineScripts(fragment);
	}
	return {
		fragment,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function locateFragment(
	canonicalRoot: string,
	filename: string,
	maxEntries: number,
	maxDepth: number,
): Promise<string> {
	const matches: string[] = [];
	const visitedDirectories = new Set<string>([canonicalRoot]);
	let inspectedEntries = 0;

	const visit = async (directory: string, depth: number): Promise<void> => {
		let entries: Dirent<string>[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new Error("Windows Visualize job root could not be inspected", {
				cause: error,
			});
		}

		for (const entry of entries) {
			inspectedEntries += 1;
			if (inspectedEntries > maxEntries) {
				throw new Error(
					`Windows Visualize job root exceeds the ${maxEntries} entry limit`,
				);
			}
			const candidatePath = join(directory, entry.name);
			let stats: Awaited<ReturnType<typeof lstat>>;
			try {
				stats = await lstat(candidatePath);
			} catch (error) {
				throw new Error(
					`Windows Visualize job entry could not be inspected: ${entry.name}`,
					{ cause: error },
				);
			}
			if (stats.isSymbolicLink()) {
				throw new Error(
					"Windows Visualize job root must not contain symbolic links or reparse-point links",
				);
			}

			let canonicalPath: string;
			try {
				canonicalPath = await realpath(candidatePath);
			} catch (error) {
				throw new Error(
					`Windows Visualize job entry could not be resolved: ${entry.name}`,
					{ cause: error },
				);
			}
			if (!isContained(canonicalRoot, canonicalPath)) {
				throw new Error(
					"Windows Visualize job entry escapes its isolated job root",
				);
			}

			if (entry.name === filename) {
				if (!stats.isFile()) {
					throw new Error("Windows Visualize fragment must be a regular file");
				}
				matches.push(canonicalPath);
				continue;
			}

			if (stats.isDirectory() && !visitedDirectories.has(canonicalPath)) {
				if (depth >= maxDepth) {
					throw new Error(
						`Windows Visualize job root exceeds the ${maxDepth} level depth limit`,
					);
				}
				visitedDirectories.add(canonicalPath);
				await visit(canonicalPath, depth + 1);
			}
		}
	};

	await visit(canonicalRoot, 0);
	if (matches.length === 0) {
		throw new Error(`Windows Visualize fragment was not found: ${filename}`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Windows Visualize worker created multiple fragments named ${filename}`,
		);
	}
	const sourcePath = matches[0];
	if (!sourcePath) {
		throw new Error(`Windows Visualize fragment was not found: ${filename}`);
	}
	return sourcePath;
}

export async function extractWindowsVisualizeArtifact({
	text,
	jobRoot,
	maxBytes = WINDOWS_VISUALIZE_MAX_FRAGMENT_BYTES,
	maxEntries = WINDOWS_VISUALIZE_MAX_JOB_ENTRIES,
	maxDepth = WINDOWS_VISUALIZE_MAX_JOB_DEPTH,
}: {
	text: string;
	jobRoot: string;
	maxBytes?: number;
	maxEntries?: number;
	maxDepth?: number;
}): Promise<WindowsVisualizeArtifact> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("Windows Visualize maxBytes must be a positive integer");
	}
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
		throw new Error("Windows Visualize maxEntries must be a positive integer");
	}
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
		throw new Error(
			"Windows Visualize maxDepth must be a non-negative integer",
		);
	}

	const filename = extractDirectiveFilename(text);
	let rootStats: Awaited<ReturnType<typeof lstat>>;
	try {
		rootStats = await lstat(jobRoot);
	} catch (error) {
		throw new Error("Windows Visualize job root is unavailable", {
			cause: error,
		});
	}
	if (rootStats.isSymbolicLink()) {
		throw new Error(
			"Windows Visualize job root must not be a symbolic link or reparse-point link",
		);
	}
	if (!rootStats.isDirectory()) {
		throw new Error("Windows Visualize job root must be a directory");
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(jobRoot);
	} catch (error) {
		throw new Error("Windows Visualize job root is unavailable", {
			cause: error,
		});
	}

	const sourcePath = await locateFragment(
		canonicalRoot,
		filename,
		maxEntries,
		maxDepth,
	);
	const candidateStats = await lstat(sourcePath);
	if (!candidateStats.isFile()) {
		throw new Error("Windows Visualize fragment must be a regular file");
	}
	if (candidateStats.size > maxBytes) {
		throw new Error(
			`Windows Visualize fragment exceeds the ${maxBytes} byte limit`,
		);
	}

	const { sha256 } = await readValidatedFragment(sourcePath, maxBytes);

	return { filename, sourcePath, validatedSha256: sha256 };
}

/**
 * Preserve the validated worker fragment and create a separate render input
 * with Hlid's inline-host gesture policy inside the isolated job root.
 */
export async function createWindowsVisualizeRenderInput({
	sourcePath,
	jobRoot,
	validatedSha256,
	maxBytes = WINDOWS_VISUALIZE_MAX_FRAGMENT_BYTES,
}: {
	sourcePath: string;
	jobRoot: string;
	validatedSha256?: string;
	maxBytes?: number;
}): Promise<string> {
	const [canonicalRoot, canonicalSource] = await Promise.all([
		realpath(jobRoot),
		realpath(sourcePath),
	]);
	if (!isContained(canonicalRoot, canonicalSource)) {
		throw new Error(
			"Windows Visualize render input escapes its isolated job root",
		);
	}

	const validated = await readValidatedFragment(canonicalSource, maxBytes, {
		// Extraction already parsed this exact byte sequence. Re-reading and
		// comparing its digest retains the post-worker mutation guard without
		// compiling every inline script twice on Hlid's event loop.
		validateScripts: validatedSha256 === undefined,
	});
	if (validatedSha256 !== undefined && validated.sha256 !== validatedSha256) {
		throw new Error(
			"Windows Visualize fragment changed after JavaScript validation",
		);
	}

	const renderInputPath = join(
		canonicalRoot,
		`.hlid-visualize-render-input-${randomUUID()}.html`,
	);
	await writeFile(
		renderInputPath,
		applyWindowsVisualizeZoomReceiver(
			applyWindowsVisualizeMobileScrollPolicy(validated.fragment),
		),
		{
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		},
	);
	return renderInputPath;
}
