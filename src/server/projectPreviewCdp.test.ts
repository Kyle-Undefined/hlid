import { describe, expect, it } from "vitest";
import {
	isSupportedProjectPreviewBrowser,
	orderProjectPreviewBrowserCandidates,
	PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS,
	PROJECT_PREVIEW_SETTLE_EXPRESSION,
	parseDevToolsActivePort,
	parseWindowsBrowserCommand,
	projectPreviewBrowserUserDataDir,
} from "./projectPreviewCdp";

describe("Project Preview browser selection", () => {
	it("extracts an executable from Windows browser commands", () => {
		expect(
			parseWindowsBrowserCommand(
				'"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1',
			),
		).toBe(
			"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		);
		expect(
			parseWindowsBrowserCommand("C:\\Browsers\\Chromium\\chrome.exe -- %1"),
		).toBe("C:\\Browsers\\Chromium\\chrome.exe");
	});

	it("accepts Chromium-compatible browsers but not Firefox", () => {
		expect(isSupportedProjectPreviewBrowser("C:\\Apps\\chrome.exe")).toBe(true);
		expect(isSupportedProjectPreviewBrowser("C:\\Apps\\brave.exe")).toBe(true);
		expect(isSupportedProjectPreviewBrowser("C:\\Apps\\firefox.exe")).toBe(
			false,
		);
	});

	it("prefers a supported default and deduplicates fallbacks", () => {
		const present = new Set([
			"C:\\Apps\\brave.exe",
			"C:\\Apps\\chrome.exe",
			"C:\\Apps\\msedge.exe",
		]);
		expect(
			orderProjectPreviewBrowserCandidates(
				"C:\\Apps\\brave.exe",
				[
					{ name: "Brave", executablePath: "C:\\Apps\\brave.exe" },
					{ name: "Chrome", executablePath: "C:\\Apps\\chrome.exe" },
					{ name: "Firefox", executablePath: "C:\\Apps\\firefox.exe" },
					{ name: "Edge", executablePath: "C:\\Apps\\msedge.exe" },
				],
				(path) => present.has(path),
			),
		).toEqual([
			{ name: "default browser", executablePath: "C:\\Apps\\brave.exe" },
			{ name: "Chrome", executablePath: "C:\\Apps\\chrome.exe" },
			{ name: "Edge", executablePath: "C:\\Apps\\msedge.exe" },
		]);
	});

	it("ignores a non-Chromium default and starts with Chrome", () => {
		expect(
			orderProjectPreviewBrowserCandidates(
				"C:\\Apps\\firefox.exe",
				[
					{ name: "Chrome", executablePath: "C:\\Apps\\chrome.exe" },
					{ name: "Edge", executablePath: "C:\\Apps\\msedge.exe" },
				],
				(path) => !path.endsWith("firefox.exe"),
			),
		).toEqual([
			{ name: "Chrome", executablePath: "C:\\Apps\\chrome.exe" },
			{ name: "Edge", executablePath: "C:\\Apps\\msedge.exe" },
		]);
	});

	it("resolves the real user-data directory for common Windows browsers", () => {
		const env = {
			LOCALAPPDATA: "C:\\Users\\Kyle\\AppData\\Local",
			APPDATA: "C:\\Users\\Kyle\\AppData\\Roaming",
		};
		expect(
			projectPreviewBrowserUserDataDir(
				"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
				"win32",
				env,
			),
		).toBe(
			"C:\\Users\\Kyle\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
		);
		expect(
			projectPreviewBrowserUserDataDir(
				"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
				"win32",
				env,
			),
		).toBe("C:\\Users\\Kyle\\AppData\\Local\\Google\\Chrome\\User Data");
	});

	it("parses consented DevTools connection metadata", () => {
		expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toEqual({
			port: 9222,
			browserPath: "/devtools/browser/abc",
		});
		expect(parseDevToolsActivePort("not-a-port\n/devtools/browser/abc")).toBe(
			null,
		);
	});

	it("creates real-profile Preview targets outside the visible tab strip", () => {
		expect(PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS).toEqual({
			url: "about:blank",
			background: true,
			hidden: true,
		});
	});

	it("settles browser actions with a serializable result", async () => {
		const settle = Function(
			`return ${PROJECT_PREVIEW_SETTLE_EXPRESSION}`,
		) as () => Promise<unknown>;
		await expect(settle()).resolves.toBe(true);
	});
});
