import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
	applyWindowsVisualizeZoomReceiver,
	validateWindowsVisualizeInlineScripts,
} from "./windowsVisualizeArtifact";

describe("Windows Visualize inline script validation in Bun", () => {
	it("forces classic-script parsing without executing the script", async () => {
		await expect(
			validateWindowsVisualizeInlineScripts("<script>const value = ;</script>"),
		).rejects.toThrow("inline script 1 has invalid JavaScript syntax");

		await expect(
			validateWindowsVisualizeInlineScripts(
				"<script>globalThis.__hlidClassicScriptRan = true;</script>",
			),
		).resolves.toBeUndefined();
		expect(
			(
				globalThis as typeof globalThis & {
					__hlidClassicScriptRan?: boolean;
				}
			).__hlidClassicScriptRan,
		).toBeUndefined();
	});

	it("parses inline modules without evaluating or resolving their imports", async () => {
		await expect(
			validateWindowsVisualizeInlineScripts(
				[
					'<script type="module">',
					'import chart from "https://example.com/chart.js";',
					"globalThis.__hlidModuleScriptRan = true;",
					"export default await Promise.resolve(chart);",
					"</script>",
				].join("\n"),
			),
		).resolves.toBeUndefined();
		expect(
			(
				globalThis as typeof globalThis & {
					__hlidModuleScriptRan?: boolean;
				}
			).__hlidModuleScriptRan,
		).toBeUndefined();

		await expect(
			validateWindowsVisualizeInlineScripts(
				[
					'<script type="module">',
					'import { chart } from "https://example.com/chart.js";',
					"export const value = chart;",
					"</script>",
				].join("\n"),
			),
		).resolves.toBeUndefined();

		await expect(
			validateWindowsVisualizeInlineScripts(
				[
					'<script type="module">',
					'import chart from "https://example.com/chart.js";',
					"export const value = ;",
					"</script>",
				].join("\n"),
			),
		).rejects.toThrow("inline script 1 has invalid JavaScript syntax");

		await expect(
			validateWindowsVisualizeInlineScripts(
				[
					'<script type="module">',
					'import chart from "https://example.com/chart.js";',
					"return chart;",
					"</script>",
				].join("\n"),
			),
		).rejects.toThrow("inline script 1 has invalid JavaScript syntax");
	});

	it.skipIf(!existsSync(chromium.executablePath()))(
		"shrinks responsive visualization geometry after layout",
		async () => {
			const browser = await chromium.launch({ headless: true });
			try {
				const page = await browser.newPage({
					viewport: { width: 800, height: 600 },
				});
				await page.setContent(
					`<!doctype html><html><head></head><body>${applyWindowsVisualizeZoomReceiver(
						[
							"<style>html,body{margin:0}#matrix{box-sizing:border-box;width:100vw;height:400px;border:4px solid}</style>",
							'<div id="matrix"><svg width="100%" height="100%"><rect width="100%" height="100%"></rect></svg></div>',
						].join(""),
					)}</body></html>`,
				);

				const before = await page.locator("#matrix").boundingBox();
				await page.evaluate(() => {
					window.postMessage(
						{ type: "hlid:visualization-zoom", version: 1, zoom: 0.5 },
						"*",
					);
				});
				await page.waitForFunction(
					() => document.documentElement.style.transform === "scale(0.5)",
				);
				const after = await page.locator("#matrix").boundingBox();
				const layoutWidth = await page
					.locator("#matrix")
					.evaluate((element) =>
						Number.parseFloat(getComputedStyle(element).width),
					);

				expect(before?.width).toBe(800);
				expect(before?.height).toBe(400);
				expect(after?.width).toBe(400);
				expect(after?.height).toBe(200);
				expect(layoutWidth).toBe(800);
			} finally {
				await browser.close();
			}
		},
	);
});
