import { describe, expect, it } from "vitest";
import {
	createProjectPreviewEventWaiter,
	isSupportedProjectPreviewBrowser,
	orderProjectPreviewBrowserCandidates,
	PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS,
	PROJECT_PREVIEW_SETTLE_EXPRESSION,
	parseDevToolsActivePort,
	parseWindowsBrowserCommand,
	projectPreviewBrowserUserDataDir,
	projectPreviewDeviceMetrics,
	projectPreviewScreenshotParams,
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
		expect(
			projectPreviewBrowserUserDataDir(
				"C:\\Browsers\\chromium.exe",
				"win32",
				env,
			),
		).toBe("C:\\Users\\Kyle\\AppData\\Local\\Chromium\\User Data");
		expect(
			projectPreviewBrowserUserDataDir(
				"C:\\Browsers\\msedge.exe",
				"win32",
				env,
			),
		).toBe("C:\\Users\\Kyle\\AppData\\Local\\Microsoft\\Edge\\User Data");
		expect(
			projectPreviewBrowserUserDataDir(
				"C:\\Browsers\\vivaldi.exe",
				"win32",
				env,
			),
		).toBe("C:\\Users\\Kyle\\AppData\\Local\\Vivaldi\\User Data");
		expect(
			projectPreviewBrowserUserDataDir("C:\\Browsers\\opera.exe", "win32", env),
		).toBe("C:\\Users\\Kyle\\AppData\\Roaming\\Opera Software\\Opera Stable");
	});

	it("requires the matching Windows profile root", () => {
		expect(
			projectPreviewBrowserUserDataDir("C:\\Browsers\\chrome.exe", "win32", {
				APPDATA: "C:\\Users\\Kyle\\AppData\\Roaming",
			}),
		).toBeNull();
		expect(
			projectPreviewBrowserUserDataDir("C:\\Browsers\\opera.exe", "win32", {
				LOCALAPPDATA: "C:\\Users\\Kyle\\AppData\\Local",
			}),
		).toBeNull();
	});

	it("resolves Linux browser profiles using Chromium config precedence", () => {
		const chromeConfigHome = "/tmp/chrome-config";
		const xdgConfigHome = "/tmp/xdg-config";
		const home = "/home/kyle";
		const env = {
			CHROME_CONFIG_HOME: chromeConfigHome,
			XDG_CONFIG_HOME: xdgConfigHome,
			HOME: home,
		};

		expect(
			projectPreviewBrowserUserDataDir("/usr/bin/brave-browser", "linux", env),
		).toBe(`${chromeConfigHome}/BraveSoftware/Brave-Browser`);
		expect(
			projectPreviewBrowserUserDataDir("/usr/bin/google-chrome", "linux", {
				XDG_CONFIG_HOME: xdgConfigHome,
				HOME: home,
			}),
		).toBe(`${xdgConfigHome}/google-chrome`);
		expect(
			projectPreviewBrowserUserDataDir("/usr/bin/chromium-browser", "linux", {
				HOME: home,
			}),
		).toBe(`${home}/.config/chromium`);
	});

	it.each([
		["brave", "BraveSoftware/Brave-Browser"],
		["google-chrome-stable", "google-chrome"],
		["chromium", "chromium"],
		["microsoft-edge", "microsoft-edge"],
		["microsoft-edge-stable", "microsoft-edge"],
		["vivaldi", "vivaldi"],
	])("maps the Linux %s profile", (executable, profile) => {
		expect(
			projectPreviewBrowserUserDataDir(`/usr/bin/${executable}`, "linux", {
				CHROME_CONFIG_HOME: "/profiles",
			}),
		).toBe(`/profiles/${profile}`);
	});

	it("rejects unsupported browsers and platforms", () => {
		expect(
			projectPreviewBrowserUserDataDir("C:\\Browsers\\firefox.exe", "win32", {
				LOCALAPPDATA: "C:\\Users\\Kyle\\AppData\\Local",
				APPDATA: "C:\\Users\\Kyle\\AppData\\Roaming",
			}),
		).toBeNull();
		expect(
			projectPreviewBrowserUserDataDir("/usr/bin/firefox", "linux", {
				HOME: "/home/kyle",
			}),
		).toBeNull();
		expect(
			projectPreviewBrowserUserDataDir("/usr/bin/constructor", "linux", {
				HOME: "/home/kyle",
			}),
		).toBeNull();
		expect(
			projectPreviewBrowserUserDataDir("C:\\Browsers\\constructor", "win32", {
				LOCALAPPDATA: "C:\\Users\\Kyle\\AppData\\Local",
			}),
		).toBeNull();
		expect(
			projectPreviewBrowserUserDataDir(
				"/Applications/Google Chrome",
				"darwin",
				{
					HOME: "/Users/kyle",
				},
			),
		).toBeNull();
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

	it("keeps CSS viewport coordinates while rendering screenshots at 2x", () => {
		expect(projectPreviewDeviceMetrics({ width: 390, height: 844 })).toEqual({
			width: 390,
			height: 844,
			deviceScaleFactor: 2,
			mobile: false,
		});
	});

	it("keeps screenshot capture lossless and compositor-backed", () => {
		expect(projectPreviewScreenshotParams(false)).toEqual({
			format: "png",
			fromSurface: true,
			captureBeyondViewport: false,
		});
		expect(
			projectPreviewScreenshotParams(true, {
				x: 0,
				y: 0,
				width: 1440,
				height: 8000,
				scale: 0.5,
			}),
		).toEqual({
			format: "png",
			fromSurface: true,
			captureBeyondViewport: true,
			clip: {
				x: 0,
				y: 0,
				width: 1440,
				height: 8000,
				scale: 0.5,
			},
		});
	});

	it("settles browser actions with a serializable result", async () => {
		const settle = Function(
			`return ${PROJECT_PREVIEW_SETTLE_EXPRESSION}`,
		) as () => Promise<unknown>;
		await expect(settle()).resolves.toBe(true);
	});

	it("cancels a pending page event without leaving its timeout active", async () => {
		let listener: ((params: Record<string, unknown>) => void) | null = null;
		let removed = false;
		const waiter = createProjectPreviewEventWaiter(
			(next) => {
				listener = next;
				return () => {
					removed = true;
					listener = null;
				};
			},
			"Page.domContentEventFired",
			1,
		);

		waiter.cancel();

		await expect(waiter.promise).resolves.toEqual({});
		expect(listener).toBeNull();
		expect(removed).toBe(true);
	});

	it("reports a page event timeout to its caller", async () => {
		let removed = false;
		const waiter = createProjectPreviewEventWaiter(
			() => () => {
				removed = true;
			},
			"Page.domContentEventFired",
			1,
		);

		await expect(waiter.promise).rejects.toThrow(
			"Timed out waiting for Page.domContentEventFired.",
		);
		expect(removed).toBe(true);
	});
});
