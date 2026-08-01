import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyWindowsVisualizeMobileScrollPolicy,
	applyWindowsVisualizeZoomReceiver,
	createWindowsVisualizeRenderInput,
	extractWindowsVisualizeArtifact,
	validateWindowsVisualizeInlineScripts,
	WINDOWS_VISUALIZE_MAX_FRAGMENT_BYTES,
} from "./windowsVisualizeArtifact";

const temporaryRoots: string[] = [];

async function makeJobRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hlid-windows-visualize-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("extractWindowsVisualizeArtifact", () => {
	it("returns the validated fragment from one standalone directive", async () => {
		const jobRoot = await makeJobRoot();
		const nestedRoot = join(
			jobRoot,
			".codex",
			"visualizations",
			"2026",
			"08",
			"01",
			"019fbab9-dea3-7133-8aab-eb8b82b67987",
		);
		await mkdir(nestedRoot, { recursive: true });
		const sourcePath = join(nestedRoot, "latency-path.html");
		await writeFile(sourcePath, '<div id="latency-path">Ready</div>');

		await expect(
			extractWindowsVisualizeArtifact({
				text: [
					"Move the slider to explore the response path.",
					"",
					'  ::codex-inline-vis{file="latency-path.html"}  ',
				].join("\r\n"),
				jobRoot,
			}),
		).resolves.toEqual({
			filename: "latency-path.html",
			sourcePath,
			validatedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it.each([
		["no directive", "Done"],
		[
			"two directives",
			[
				'::codex-inline-vis{file="one.html"}',
				'::codex-inline-vis{file="two.html"}',
			].join("\n"),
		],
		[
			"an inline directive",
			'Open ::codex-inline-vis{file="latency-path.html"}',
		],
		[
			"extra attributes",
			'::codex-inline-vis{file="latency-path.html" title="unsafe"}',
		],
		["a nested path", '::codex-inline-vis{file="nested/path.html"}'],
		["an absolute path", '::codex-inline-vis{file="C:\\path.html"}'],
		["an uppercase name", '::codex-inline-vis{file="Latency-Path.html"}'],
		["an underscore", '::codex-inline-vis{file="latency_path.html"}'],
	])("rejects %s", async (_label, text) => {
		const jobRoot = await makeJobRoot();
		await expect(
			extractWindowsVisualizeArtifact({ text, jobRoot }),
		).rejects.toThrow("exactly one standalone");
	});

	it("rejects a missing fragment", async () => {
		const jobRoot = await makeJobRoot();
		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="missing.html"}',
				jobRoot,
			}),
		).rejects.toThrow("was not found");
	});

	it("rejects multiple recursively matching fragments", async () => {
		const jobRoot = await makeJobRoot();
		const first = join(jobRoot, "first");
		const second = join(jobRoot, "second", "nested");
		await mkdir(first, { recursive: true });
		await mkdir(second, { recursive: true });
		await writeFile(join(first, "duplicate.html"), "<div>first</div>");
		await writeFile(join(second, "duplicate.html"), "<div>second</div>");

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="duplicate.html"}',
				jobRoot,
			}),
		).rejects.toThrow("multiple fragments");
	});

	it("bounds recursive job-root entry inspection", async () => {
		const jobRoot = await makeJobRoot();
		await Promise.all(
			["one.txt", "two.txt", "three.txt"].map((filename) =>
				writeFile(join(jobRoot, filename), filename),
			),
		);

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="missing.html"}',
				jobRoot,
				maxEntries: 2,
			}),
		).rejects.toThrow("2 entry limit");
	});

	it("bounds recursive job-root depth", async () => {
		const jobRoot = await makeJobRoot();
		await mkdir(join(jobRoot, "one", "two"), { recursive: true });

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="missing.html"}',
				jobRoot,
				maxDepth: 1,
			}),
		).rejects.toThrow("1 level depth limit");
	});

	it("rejects directories and symbolic links", async () => {
		const directoryJobRoot = await makeJobRoot();
		await mkdir(join(directoryJobRoot, "directory.html"));

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="directory.html"}',
				jobRoot: directoryJobRoot,
			}),
		).rejects.toThrow("regular file");

		const symlinkJobRoot = await makeJobRoot();
		await writeFile(join(symlinkJobRoot, "target.html"), "<div>target</div>");
		await symlink(
			join(symlinkJobRoot, "target.html"),
			join(symlinkJobRoot, "linked.html"),
		);
		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="linked.html"}',
				jobRoot: symlinkJobRoot,
			}),
		).rejects.toThrow("symbolic links");
	});

	it("does not traverse a symbolic-link directory outside the job root", async () => {
		const jobRoot = await makeJobRoot();
		const outsideRoot = await makeJobRoot();
		await writeFile(join(outsideRoot, "escaped.html"), "<div>outside</div>");
		await symlink(outsideRoot, join(jobRoot, "linked-directory"), "dir");

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="escaped.html"}',
				jobRoot,
			}),
		).rejects.toThrow("symbolic links");
	});

	it("rejects a symbolic-link job root", async () => {
		const parentRoot = await makeJobRoot();
		const realJobRoot = await makeJobRoot();
		await writeFile(join(realJobRoot, "linked-root.html"), "<div>test</div>");
		const linkedRoot = join(parentRoot, "linked-root");
		await symlink(realJobRoot, linkedRoot, "dir");

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="linked-root.html"}',
				jobRoot: linkedRoot,
			}),
		).rejects.toThrow("job root must not be a symbolic link");
	});

	it("rejects fragments over the byte limit", async () => {
		const jobRoot = await makeJobRoot();
		await writeFile(
			join(jobRoot, "oversized.html"),
			Buffer.alloc(WINDOWS_VISUALIZE_MAX_FRAGMENT_BYTES + 1, 0x20),
		);

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="oversized.html"}',
				jobRoot,
			}),
		).rejects.toThrow("exceeds");
	});

	it("supports a smaller caller-provided byte limit", async () => {
		const jobRoot = await makeJobRoot();
		await writeFile(join(jobRoot, "small.html"), "<div>123</div>");

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="small.html"}',
				jobRoot,
				maxBytes: 4,
			}),
		).rejects.toThrow("4 byte limit");
	});

	it("rejects invalid UTF-8", async () => {
		const jobRoot = await makeJobRoot();
		await writeFile(join(jobRoot, "invalid.html"), Buffer.from([0xc3, 0x28]));

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="invalid.html"}',
				jobRoot,
			}),
		).rejects.toThrow("valid UTF-8");
	});

	it.each([
		"<!doctype html><div>test</div>",
		"<html><div>test</div></html>",
		"<head><title>test</title></head><div>test</div>",
		"<body><div>test</div></body>",
	])("rejects full-document markup: %s", async (fragment) => {
		const jobRoot = await makeJobRoot();
		await writeFile(join(jobRoot, "document.html"), fragment);

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="document.html"}',
				jobRoot,
			}),
		).rejects.toThrow("must not contain");
	});

	it("rejects a fragment whose inline JavaScript cannot be parsed", async () => {
		const jobRoot = await makeJobRoot();
		await writeFile(
			join(jobRoot, "broken.html"),
			[
				'<div id="chart">Static fallback</div>',
				"<script>",
				"const categories = ['one', 'two'];",
				"const active = new Set(categories.map((_, index) => index);",
				"</script>",
			].join("\n"),
		);

		await expect(
			extractWindowsVisualizeArtifact({
				text: '::codex-inline-vis{file="broken.html"}',
				jobRoot,
			}),
		).rejects.toThrow("inline script 1 has invalid JavaScript syntax");
	});
});

describe("validateWindowsVisualizeInlineScripts", () => {
	it("parses classic inline scripts without executing them", async () => {
		await expect(
			validateWindowsVisualizeInlineScripts(
				"<script>globalThis.__mustNotRun = true;</script>",
			),
		).resolves.toBeUndefined();
		expect(
			(globalThis as typeof globalThis & { __mustNotRun?: boolean })
				.__mustNotRun,
		).toBeUndefined();
	});

	it("ignores external and data script bodies", async () => {
		await expect(
			validateWindowsVisualizeInlineScripts(
				[
					'<script src="https://example.com/chart.js">not valid JavaScript =</script>',
					'<script type="application/json">{"points": [1, 2]}</script>',
				].join("\n"),
			),
		).resolves.toBeUndefined();
	});

	it.each([
		"data-src",
		"data-type",
	])("does not treat %s as an executable-script attribute", async (attribute) => {
		await expect(
			validateWindowsVisualizeInlineScripts(
				`<script ${attribute}="module">const value = ;</script>`,
			),
		).rejects.toThrow("inline script 1 has invalid JavaScript syntax");
	});

	it("accepts a valid inline module when module parsing is available", async () => {
		await expect(
			validateWindowsVisualizeInlineScripts(
				'<script type="module">export const value = 1;</script>',
			),
		).resolves.toBeUndefined();
	});
});

describe("createWindowsVisualizeRenderInput", () => {
	it("adds a coarse-pointer policy that keeps the inline visualization scrollable", async () => {
		const jobRoot = await makeJobRoot();
		const sourcePath = join(jobRoot, "network.html");
		const fragment = [
			"<style>#network { touch-action: none; }</style>",
			'<div id="network">Network</div>',
		].join("\n");
		await writeFile(sourcePath, fragment);

		const renderInputPath = await createWindowsVisualizeRenderInput({
			sourcePath,
			jobRoot,
		});
		const renderInput = await readFile(renderInputPath, "utf-8");

		expect(renderInputPath).not.toBe(sourcePath);
		expect(renderInput).toContain(fragment);
		expect(renderInput).toContain("data-hlid-mobile-scroll-policy");
		expect(renderInput).toContain("data-hlid-visualization-zoom-receiver");
		expect(renderInput).toContain(
			"touch-action: pan-x pan-y pinch-zoom !important",
		);
		expect(renderInput.indexOf(fragment)).toBeLessThan(
			renderInput.indexOf("data-hlid-mobile-scroll-policy"),
		);
		expect(renderInput.indexOf("data-hlid-mobile-scroll-policy")).toBeLessThan(
			renderInput.indexOf("data-hlid-visualization-zoom-receiver"),
		);
		await expect(
			validateWindowsVisualizeInlineScripts(renderInput),
		).resolves.toBeUndefined();
	});

	it("keeps the host policy available as a pure transform", () => {
		const fragment = '<div id="chart">Chart</div>\n';
		const result = applyWindowsVisualizeMobileScrollPolicy(fragment);

		expect(result.startsWith(fragment)).toBe(true);
		expect(result).toContain("@media (hover: none) and (pointer: coarse)");
	});

	it("adds a bounded zoom receiver as a pure transform", async () => {
		const fragment = '<div id="chart">Chart</div>\n';
		const result = applyWindowsVisualizeZoomReceiver(fragment);

		expect(result.startsWith(fragment)).toBe(true);
		expect(result).toContain("data-hlid-visualization-zoom-receiver");
		expect(result).toContain("data.type !== MESSAGE_TYPE");
		expect(result).toContain("event.source !== parent");
		expect(result).toContain("data.zoom < 0.5");
		expect(result).toContain("data.zoom > 1.5");
		expect(result).toContain('root.style.transformOrigin = "0 0"');
		expect(result).toContain('"scale(" + data.zoom + ")"');
		expect(result).not.toContain("style.zoom");
		await expect(
			validateWindowsVisualizeInlineScripts(result),
		).resolves.toBeUndefined();
	});

	it("rejects a source outside the isolated job root", async () => {
		const jobRoot = await makeJobRoot();
		const outsideRoot = await makeJobRoot();
		const sourcePath = join(outsideRoot, "outside.html");
		await writeFile(sourcePath, "<div>Outside</div>");

		await expect(
			createWindowsVisualizeRenderInput({ sourcePath, jobRoot }),
		).rejects.toThrow("escapes its isolated job root");
	});

	it("rejects a fragment changed after its JavaScript was validated", async () => {
		const jobRoot = await makeJobRoot();
		const sourcePath = join(jobRoot, "changed.html");
		await writeFile(
			sourcePath,
			'<div id="chart">Ready</div><script>const value = 1;</script>',
		);
		const artifact = await extractWindowsVisualizeArtifact({
			text: '::codex-inline-vis{file="changed.html"}',
			jobRoot,
		});
		await writeFile(
			sourcePath,
			'<div id="chart">Changed</div><script>const value = 2;</script>',
		);

		await expect(
			createWindowsVisualizeRenderInput({
				sourcePath,
				jobRoot,
				validatedSha256: artifact.validatedSha256,
			}),
		).rejects.toThrow("changed after JavaScript validation");
	});
});
