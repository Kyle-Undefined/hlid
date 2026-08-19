import { describe, expect, it, vi } from "vitest";
import {
	CdpClient,
	configureProjectPreviewNetwork,
	createProjectPreviewEventWaiter,
	isExpectedProjectPreviewRequestCancellation,
	isSupportedProjectPreviewBrowser,
	orderProjectPreviewBrowserCandidates,
	PROJECT_PREVIEW_ATTACHED_TARGET_PARAMS,
	PROJECT_PREVIEW_SETTLE_EXPRESSION,
	ProjectPreviewRequestDiagnostics,
	parseDevToolsActivePort,
	parseWindowsBrowserCommand,
	projectPreviewBrowserUserDataDir,
	projectPreviewDeviceMetrics,
	projectPreviewScreenshotParams,
	waitForProjectPreviewNetworkQuiet,
} from "./projectPreviewCdp";

describe("Project Preview browser selection", () => {
	it("invalidates the CDP transport after a command timeout", async () => {
		const sockets: FakeWebSocket[] = [];
		class FakeWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = 0;
			onopen: (() => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			send = vi.fn();
			close = vi.fn(() => {
				this.readyState = FakeWebSocket.CLOSED;
				this.onclose?.();
			});

			constructor(_url: string) {
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = FakeWebSocket.OPEN;
					this.onopen?.();
				});
			}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		try {
			const client = await CdpClient.connect(
				"ws://preview.test/devtools/page/1",
				new AbortController().signal,
				100,
			);
			const initiating = expect(
				client.send("Page.navigate", {}, 5),
			).rejects.toThrow("Preview browser command Page.navigate timed out.");
			const concurrent = expect(
				client.send("Runtime.evaluate", {}, 1_000),
			).rejects.toThrow("CDP connection closed.");

			await initiating;
			await concurrent;
			expect(client.isConnected()).toBe(false);
			expect(sockets[0]?.close).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("bypasses service workers before authorizing the private browser relay", async () => {
		const sender = {
			send: vi.fn(async () => ({})),
		};

		await configureProjectPreviewNetwork(sender, {
			kind: "project",
			origin: "http://hlid-test.localhost:6173",
			cookieName: "__hlid_agent_preview_test",
			cookieToken: "agent-relay-test-token",
		});

		expect(sender.send.mock.calls).toEqual([
			["Network.enable"],
			["Network.setBypassServiceWorker", { bypass: true }],
			[
				"Network.setCookie",
				{
					name: "__hlid_agent_preview_test",
					value: "agent-relay-test-token",
					url: "http://hlid-test.localhost:6173",
					httpOnly: true,
					sameSite: "Strict",
				},
			],
		]);
	});

	it("waits for a quiet navigation window but remains bounded", async () => {
		vi.useFakeTimers();
		try {
			let pending = 1;
			let settled = false;
			const waiting = waitForProjectPreviewNetworkQuiet(() => pending, {
				quietMs: 100,
				timeoutMs: 500,
				pollMs: 10,
			}).then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(40);
			pending = 0;
			await vi.advanceTimersByTimeAsync(60);
			pending = 1;
			await vi.advanceTimersByTimeAsync(20);
			pending = 0;
			await vi.advanceTimersByTimeAsync(90);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(20);
			await waiting;
			expect(settled).toBe(true);

			pending = 1;
			const bounded = waitForProjectPreviewNetworkQuiet(() => pending, {
				quietMs: 100,
				timeoutMs: 150,
				pollMs: 10,
			});
			await vi.advanceTimersByTimeAsync(150);
			await bounded;
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not report expected navigation cancellations as request failures", () => {
		expect(
			isExpectedProjectPreviewRequestCancellation({
				errorText: "net::ERR_ABORTED",
			}),
		).toBe(true);
		expect(
			isExpectedProjectPreviewRequestCancellation({
				canceled: true,
				errorText: "net::ERR_FAILED",
			}),
		).toBe(true);
		expect(
			isExpectedProjectPreviewRequestCancellation({
				errorText: "net::ERR_BLOCKED_BY_CLIENT",
			}),
		).toBe(false);
	});

	it("reports HTTP errors once alongside transport failures", () => {
		const diagnostics = new ProjectPreviewRequestDiagnostics();
		diagnostics.requestWillBeSent({
			requestId: "manifest-1",
			request: {
				method: "GET",
				url: "http://hlid-test.localhost:6173/manifest.json?cache=1",
			},
		});
		diagnostics.responseReceived({
			requestId: "manifest-1",
			response: {
				status: 401,
				statusText: "Unauthorized",
				url: "http://hlid-test.localhost:6173/manifest.json?cache=1",
			},
		});
		diagnostics.responseReceived({
			requestId: "manifest-1",
			response: {
				status: 401,
				statusText: "Unauthorized",
				url: "http://hlid-test.localhost:6173/manifest.json?cache=1",
			},
		});
		diagnostics.loadingFailed({
			requestId: "manifest-1",
			errorText: "net::ERR_FAILED",
		});

		diagnostics.requestWillBeSent({
			requestId: "manifest-2",
			request: {
				method: "GET",
				url: "http://hlid-test.localhost:6173/manifest.json",
			},
		});
		diagnostics.responseReceived({
			requestId: "manifest-2",
			response: {
				status: 401,
				statusText: "Unauthorized",
				url: "http://hlid-test.localhost:6173/manifest.json",
			},
		});
		diagnostics.loadingFinished({ requestId: "manifest-2" });

		diagnostics.requestWillBeSent({
			requestId: "asset-1",
			request: {
				method: "GET",
				url: "http://hlid-test.localhost:6173/app.js",
			},
		});
		diagnostics.responseReceived({
			requestId: "asset-1",
			response: { status: 200, statusText: "OK" },
		});
		diagnostics.loadingFinished({ requestId: "asset-1" });

		diagnostics.requestWillBeSent({
			requestId: "api-500",
			request: {
				method: "GET",
				url: "http://hlid-test.localhost:6173/api/status",
			},
		});
		diagnostics.responseReceived({
			requestId: "api-500",
			response: { status: 503, statusText: "Service Unavailable" },
		});
		diagnostics.loadingFinished({ requestId: "api-500" });

		diagnostics.requestWillBeSent({
			requestId: "api-1",
			request: {
				method: "POST",
				url: "http://hlid-test.localhost:6173/api/save",
			},
		});
		diagnostics.loadingFailed({
			requestId: "api-1",
			errorText: "net::ERR_CONNECTION_RESET",
		});

		expect(diagnostics.snapshot()).toEqual([
			"GET http://hlid-test.localhost:6173/manifest.json · HTTP 401 Unauthorized",
			"GET http://hlid-test.localhost:6173/api/status · HTTP 503 Service Unavailable",
			"POST http://hlid-test.localhost:6173/api/save · net::ERR_CONNECTION_RESET",
		]);
		expect(diagnostics.pendingCount()).toBe(0);
	});

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
