import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
	chromium,
	type BrowserContext,
	type CDPSession,
	type Page,
} from "playwright";

const repoRoot = resolve(import.meta.dir, "../..");
const PERF_SESSION_ID = "perf-session";
const PERF_READY_SENTINEL = "PERF_READY_SENTINEL";
const PERF_STREAM_SENTINEL = "PERF_STREAM_DONE";
const PASSWORD = "hlid-performance-gate";
const cdpSessions = new WeakMap<Page, CDPSession>();

type MetricMap = Record<string, number>;
type BrowserSnapshot = {
	taskDurationMs: number;
	scriptDurationMs: number;
	layoutDurationMs: number;
	recalcStyleDurationMs: number;
	jsHeapUsedBytes: number;
	jsHeapTotalBytes: number;
	domNodes: number;
	documents: number;
	frames: number;
	longTaskCount: number;
	longTaskDurationMs: number;
	webSocketMessages: number;
	webSocketBytes: number;
	transferBytes: number;
	encodedBodyBytes: number;
};

type GateReport = {
	label: string;
	createdAt: string;
	commit: string;
	idleDurationMs: number;
	serverStartupMs: number;
	bundle: {
		clientBytes: number;
		shellPreloadBytes: number;
		shellPreloadGzipBytes: number;
	};
	desktop: {
		readinessMs: number;
		initial: BrowserSnapshot;
		toolRevealMs: number;
		toolRevealDelta: BrowserSnapshot;
		streamMs: number;
		streamDelta: BrowserSnapshot;
		idleDelta: BrowserSnapshot;
		idleTaskPercent: number;
		idleHeapGrowthBytes: number;
		idleWebSocketMessageTypes: Record<string, number>;
	};
	mobile: {
		readinessMs: number;
		initial: BrowserSnapshot;
	};
	budgets: Array<{
		name: string;
		actual: number;
		limit: number;
		unit: string;
		passed: boolean;
	}>;
};

function argument(name: string): string | undefined {
	const prefix = `--${name}=`;
	for (let index = process.argv.length - 1; index >= 0; index--) {
		const value = process.argv[index];
		if (value?.startsWith(prefix)) return value.slice(prefix.length);
	}
	return undefined;
}

const idleDurationMs = Number(argument("idle-ms") ?? 15 * 60_000);
const label = argument("label") ?? "baseline";
const cpuProfileOutput = argument("cpu-profile");
const keepTemp = process.argv.includes("--keep-temp");
const skipBuild = process.argv.includes("--skip-build");
if (!Number.isFinite(idleDurationMs) || idleDurationMs < 1_000) {
	throw new Error("--idle-ms must be at least 1000");
}

function run(
	command: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
	const child = Bun.spawn(command, {
		cwd: options.cwd ?? repoRoot,
		env: { ...process.env, ...options.env },
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited.then((code) => {
		if (code !== 0) {
			throw new Error(`${command.join(" ")} exited with ${code}`);
		}
	});
}

async function gitHead(): Promise<string> {
	const child = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
		cwd: repoRoot,
		stdout: "pipe",
	});
	const output = await new Response(child.stdout).text();
	if ((await child.exited) !== 0) return "unknown";
	return output.trim();
}

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("Unable to reserve a performance port");
	return port;
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function directoryBytes(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) total += directoryBytes(child);
		else total += statSync(child).size;
	}
	return total;
}

function bundleMetrics() {
	const clientDir = resolve(repoRoot, "dist/client");
	const shell = readFileSync(resolve(clientDir, "_shell.html"), "utf8");
	const preloads = [
		...shell.matchAll(/<link rel="modulepreload" href="([^"]+)"/g),
	].map((match) => match[1]);
	let shellPreloadBytes = 0;
	let shellPreloadGzipBytes = 0;
	for (const preload of preloads) {
		if (!preload) continue;
		const file = resolve(clientDir, preload.replace(/^\//, ""));
		const bytes = readFileSync(file);
		shellPreloadBytes += bytes.byteLength;
		shellPreloadGzipBytes += gzipSync(bytes).byteLength;
	}
	return {
		clientBytes: directoryBytes(clientDir),
		shellPreloadBytes,
		shellPreloadGzipBytes,
	};
}

async function waitForServer(url: string, timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/health`, {
				redirect: "manual",
				signal: AbortSignal.timeout(1_000),
			});
			if (response.status !== 503) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`Hlid did not become ready at ${url}`);
}

async function installLongTaskObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const target = window as typeof window & {
			__hlidLongTasks?: Array<{ duration: number }>;
			__hlidWebSocketMessages?: Record<string, number>;
			__hlidWebSocketBytes?: number;
		};
		target.__hlidLongTasks = [];
		target.__hlidWebSocketMessages = {};
		target.__hlidWebSocketBytes = 0;
		const NativeWebSocket = window.WebSocket;
		window.WebSocket = class extends NativeWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => {
					const text = typeof event.data === "string" ? event.data : "";
					target.__hlidWebSocketBytes =
						(target.__hlidWebSocketBytes ?? 0) + text.length;
					let type = "non-json";
					try {
						const parsed = JSON.parse(text) as { type?: unknown };
						if (typeof parsed.type === "string") type = parsed.type;
					} catch {}
					const counts = target.__hlidWebSocketMessages ?? {};
					counts[type] = (counts[type] ?? 0) + 1;
					target.__hlidWebSocketMessages = counts;
				});
			}
		} as typeof WebSocket;
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					target.__hlidLongTasks?.push({ duration: entry.duration });
				}
			}).observe({ type: "longtask", buffered: true });
		} catch {}
	});
}

async function login(page: Page, baseUrl: string): Promise<void> {
	const status = await fetch(`${baseUrl}/api/auth/status`);
	if (!status.ok) throw new Error(`Authentication status returned ${status.status}`);
	const { state } = (await status.json()) as { state: string };
	const action = state === "setup-required" ? "setup" : "login";
	const response = await fetch(`${baseUrl}/api/auth/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	if (!response.ok) {
		throw new Error(`Authentication ${action} returned ${response.status}`);
	}
	const setCookie = response.headers.get("set-cookie") ?? "";
	const token = setCookie.match(/(?:^|;\s*)hlid_session=([^;]+)/)?.[1];
	if (!token) throw new Error(`Authentication ${action} returned no session cookie`);
	await page.context().addCookies([
		{
			name: "hlid_session",
			value: decodeURIComponent(token),
			url: baseUrl,
			httpOnly: true,
			sameSite: "Strict",
		},
	]);
}

async function cdpSession(
	context: BrowserContext,
	page: Page,
): Promise<CDPSession> {
	const existing = cdpSessions.get(page);
	if (existing) return existing;
	const session = await context.newCDPSession(page);
	await session.send("Performance.enable");
	cdpSessions.set(page, session);
	return session;
}

async function cdpMetrics(context: BrowserContext, page: Page): Promise<MetricMap> {
	const session = await cdpSession(context, page);
	const response = (await session.send("Performance.getMetrics")) as {
		metrics: Array<{ name: string; value: number }>;
	};
	return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

async function collectGarbage(context: BrowserContext, page: Page): Promise<void> {
	const session = await cdpSession(context, page);
	await session.send("HeapProfiler.collectGarbage").catch(() => {});
}

async function snapshot(
	context: BrowserContext,
	page: Page,
): Promise<BrowserSnapshot> {
	const metrics = await cdpMetrics(context, page);
	const client = await page.evaluate(() => {
		const target = window as typeof window & {
			__hlidLongTasks?: Array<{ duration: number }>;
			__hlidWebSocketMessages?: Record<string, number>;
			__hlidWebSocketBytes?: number;
		};
		const resources = performance.getEntriesByType(
			"resource",
		) as PerformanceResourceTiming[];
		return {
			domNodes: document.getElementsByTagName("*").length,
			longTasks: target.__hlidLongTasks ?? [],
			webSocketMessages: Object.values(
				target.__hlidWebSocketMessages ?? {},
			).reduce((sum, count) => sum + count, 0),
			webSocketBytes: target.__hlidWebSocketBytes ?? 0,
			transferBytes: resources.reduce((sum, item) => sum + item.transferSize, 0),
			encodedBodyBytes: resources.reduce(
				(sum, item) => sum + item.encodedBodySize,
				0,
			),
		};
	});
	return {
		taskDurationMs: (metrics.TaskDuration ?? 0) * 1_000,
		scriptDurationMs: (metrics.ScriptDuration ?? 0) * 1_000,
		layoutDurationMs: (metrics.LayoutDuration ?? 0) * 1_000,
		recalcStyleDurationMs: (metrics.RecalcStyleDuration ?? 0) * 1_000,
		jsHeapUsedBytes: metrics.JSHeapUsedSize ?? 0,
		jsHeapTotalBytes: metrics.JSHeapTotalSize ?? 0,
		domNodes: client.domNodes,
		documents: metrics.Documents ?? 0,
		frames: metrics.Frames ?? 0,
		longTaskCount: client.longTasks.length,
		longTaskDurationMs: client.longTasks.reduce(
			(sum, item) => sum + item.duration,
			0,
		),
		webSocketMessages: client.webSocketMessages,
		webSocketBytes: client.webSocketBytes,
		transferBytes: client.transferBytes,
		encodedBodyBytes: client.encodedBodyBytes,
	};
}

async function webSocketMessageCounts(page: Page): Promise<Record<string, number>> {
	return page.evaluate(() => {
		const target = window as typeof window & {
			__hlidWebSocketMessages?: Record<string, number>;
		};
		return { ...(target.__hlidWebSocketMessages ?? {}) };
	});
}

function countDelta(
	after: Record<string, number>,
	before: Record<string, number>,
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(after)
			.map(([key, value]) => [key, value - (before[key] ?? 0)] as const)
			.filter(([, value]) => value !== 0),
	);
}

function delta(after: BrowserSnapshot, before: BrowserSnapshot): BrowserSnapshot {
	return Object.fromEntries(
		Object.keys(after).map((key) => [
			key,
			after[key as keyof BrowserSnapshot] - before[key as keyof BrowserSnapshot],
		]),
	) as BrowserSnapshot;
}

async function navigateRaven(page: Page, baseUrl: string): Promise<number> {
	const startedAt = performance.now();
	await page.goto(`${baseUrl}/raven?session=${PERF_SESSION_ID}`, {
		waitUntil: "domcontentloaded",
	});
	await page.getByText(PERF_READY_SENTINEL, { exact: false }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await page.locator('textarea[role="combobox"]').waitFor({ state: "visible" });
	return performance.now() - startedAt;
}

function budget(name: string, actual: number, limit: number, unit: string) {
	return { name, actual, limit, unit, passed: actual <= limit };
}

const tempRoot = mkdtempSync(join(tmpdir(), "hlid-perf-gate-"));
const homeDir = resolve(tempRoot, "home");
const executable = resolve(tempRoot, "hlid-perf.exe");
mkdirSync(homeDir, { recursive: true });
const port = freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const bunExecutable = process.execPath;
const fakeAgent = resolve(repoRoot, "scripts/perf/fake-agent.mjs");
writeFileSync(
	resolve(tempRoot, "hlid.config.toml"),
	[
		`vault_provider = "acp:opencode"`,
		"",
		"[vault]",
		`name = "Performance Gate"`,
		`path = ${tomlString(tempRoot)}`,
		"",
		"[server]",
		`port = ${port}`,
		"local_network_access = false",
		"",
		"[voice]",
		"enabled = false",
		"",
		"[[agents]]",
		`path = ${tomlString(tempRoot)}`,
		`name = "Performance Gate"`,
		`provider = "acp:opencode"`,
		"",
		"[[acp_agents]]",
		`id = "opencode"`,
		`executable = ${tomlString(bunExecutable)}`,
		`args = [${tomlString(fakeAgent)}]`,
		"",
	].join("\n"),
);

let server: ReturnType<typeof Bun.spawn> | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
	if (!skipBuild) await run(["bun", "run", "build"]);
	const build = await Bun.build({
		entrypoints: [resolve(repoRoot, "src/server/index.ts")],
		compile: { outfile: executable },
	});
	if (!build.success) {
		throw new Error(build.logs.map((entry) => entry.message).join("\n"));
	}
	await run(["bun", resolve(repoRoot, "scripts/perf/seed.ts")], {
		cwd: tempRoot,
		env: { HOME: homeDir, HLID_AUTH_PATH: resolve(tempRoot, "auth.json") },
	});

	const serverStartedAt = performance.now();
	server = Bun.spawn([executable, "--background"], {
		cwd: tempRoot,
		env: {
			...process.env,
			HOME: homeDir,
			HLID_AUTH_PATH: resolve(tempRoot, "auth.json"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	await waitForServer(baseUrl);
	const serverStartupMs = performance.now() - serverStartedAt;

	browser = await chromium.launch({ headless: true });
	const desktopContext = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		serviceWorkers: "block",
	});
	const desktopPage = await desktopContext.newPage();
	await installLongTaskObserver(desktopPage);
	await login(desktopPage, baseUrl);
	const desktopReadinessMs = await navigateRaven(desktopPage, baseUrl);
	await collectGarbage(desktopContext, desktopPage);
	const desktopInitial = await snapshot(desktopContext, desktopPage);

	const reveal = desktopPage.getByRole("button", {
		name: /Show \d+ earlier tool calls/,
	});
	const beforeReveal = await snapshot(desktopContext, desktopPage);
	const toolRevealStartedAt = performance.now();
	await reveal.click();
	await reveal.waitFor({ state: "hidden" });
	await desktopPage.evaluate(
		() =>
			new Promise<void>((resolveFrame) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
			),
	);
	const toolRevealMs = performance.now() - toolRevealStartedAt;
	const afterReveal = await snapshot(desktopContext, desktopPage);

	const composer = desktopPage.locator('textarea[role="combobox"]');
	await composer.fill("perf-stream");
	const beforeStream = await snapshot(desktopContext, desktopPage);
	const streamStartedAt = performance.now();
	await desktopPage.getByRole("button", { name: "Send" }).click();
	await desktopPage.getByText(PERF_STREAM_SENTINEL, { exact: false }).waitFor({
		state: "visible",
		timeout: 20_000,
	});
	await desktopPage.getByRole("button", { name: "Send" }).waitFor({
		state: "visible",
	});
	const streamMs = performance.now() - streamStartedAt;
	const afterStream = await snapshot(desktopContext, desktopPage);

	await collectGarbage(desktopContext, desktopPage);
	const beforeIdle = await snapshot(desktopContext, desktopPage);
	const beforeIdleWebSocketMessages = await webSocketMessageCounts(desktopPage);
	const idleCdp = await cdpSession(desktopContext, desktopPage);
	if (cpuProfileOutput) {
		await idleCdp.send("Profiler.enable");
		await idleCdp.send("Profiler.start");
	}
	await Bun.sleep(idleDurationMs);
	if (cpuProfileOutput) {
		const { profile } = (await idleCdp.send("Profiler.stop")) as {
			profile: unknown;
		};
		const profilePath = resolve(repoRoot, cpuProfileOutput);
		mkdirSync(dirname(profilePath), { recursive: true });
		writeFileSync(profilePath, `${JSON.stringify(profile)}\n`);
	}
	const afterIdleActivity = await snapshot(desktopContext, desktopPage);
	const afterIdleWebSocketMessages = await webSocketMessageCounts(desktopPage);
	await collectGarbage(desktopContext, desktopPage);
	const afterIdleGarbageCollection = await snapshot(desktopContext, desktopPage);
	const idleDelta = delta(afterIdleActivity, beforeIdle);
	idleDelta.jsHeapUsedBytes =
		afterIdleGarbageCollection.jsHeapUsedBytes - beforeIdle.jsHeapUsedBytes;
	idleDelta.jsHeapTotalBytes =
		afterIdleGarbageCollection.jsHeapTotalBytes - beforeIdle.jsHeapTotalBytes;

	const mobileContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		serviceWorkers: "block",
	});
	const mobilePage = await mobileContext.newPage();
	await installLongTaskObserver(mobilePage);
	await login(mobilePage, baseUrl);
	const mobileReadinessMs = await navigateRaven(mobilePage, baseUrl);
	await collectGarbage(mobileContext, mobilePage);
	const mobileInitial = await snapshot(mobileContext, mobilePage);

	const toolRevealDelta = delta(afterReveal, beforeReveal);
	const streamDelta = delta(afterStream, beforeStream);
	const idleTaskPercent =
		idleDurationMs > 0 ? (idleDelta.taskDurationMs / idleDurationMs) * 100 : 0;
	const idleHeapGrowthBytes = idleDelta.jsHeapUsedBytes;
	const idleWebSocketMessageTypes = countDelta(
		afterIdleWebSocketMessages,
		beforeIdleWebSocketMessages,
	);
	const budgets = [
		budget("server startup", serverStartupMs, 10_000, "ms"),
		budget("desktop Raven readiness", desktopReadinessMs, 4_000, "ms"),
		budget("desktop DOM nodes", desktopInitial.domNodes, 12_000, "nodes"),
		budget(
			"desktop heap",
			desktopInitial.jsHeapUsedBytes,
			160 * 1024 * 1024,
			"bytes",
		),
		budget("tool history reveal", toolRevealMs, 1_500, "ms"),
		budget("stream completion", streamMs, 8_000, "ms"),
		budget("stream long tasks", streamDelta.longTaskDurationMs, 2_000, "ms"),
		budget("visible idle task share", idleTaskPercent, 2, "%"),
		budget(
			"visible idle WebSocket messages",
			idleDelta.webSocketMessages,
			3,
			"messages",
		),
		budget(
			"visible idle heap growth",
			Math.max(0, idleHeapGrowthBytes),
			8 * 1024 * 1024,
			"bytes",
		),
		budget("mobile Raven readiness", mobileReadinessMs, 6_000, "ms"),
		budget("mobile DOM nodes", mobileInitial.domNodes, 12_000, "nodes"),
		budget(
			"mobile heap",
			mobileInitial.jsHeapUsedBytes,
			160 * 1024 * 1024,
			"bytes",
		),
	];

	const report: GateReport = {
		label,
		createdAt: new Date().toISOString(),
		commit: await gitHead(),
		idleDurationMs,
		serverStartupMs,
		bundle: bundleMetrics(),
		desktop: {
			readinessMs: desktopReadinessMs,
			initial: desktopInitial,
			toolRevealMs,
			toolRevealDelta,
			streamMs,
			streamDelta,
			idleDelta,
			idleTaskPercent,
			idleHeapGrowthBytes,
			idleWebSocketMessageTypes,
		},
		mobile: { readinessMs: mobileReadinessMs, initial: mobileInitial },
		budgets,
	};
	const requestedOutput = argument("output");
	const output = requestedOutput
		? resolve(repoRoot, requestedOutput)
		: resolve(
				repoRoot,
				"reports/performance",
				`${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${label}.json`,
			);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

	console.log(`Performance report: ${output}`);
	console.table(
		budgets.map((entry) => ({
			budget: entry.name,
			actual: Number(entry.actual.toFixed(2)),
			limit: entry.limit,
			unit: entry.unit,
			passed: entry.passed,
		})),
	);
	const failures = budgets.filter((entry) => !entry.passed);
	if (failures.length > 0) {
		throw new Error(
			`Performance gate failed: ${failures.map((entry) => entry.name).join(", ")}`,
		);
	}

	await desktopContext.close();
	await mobileContext.close();
} finally {
	if (browser) await browser.close().catch(() => {});
	if (server) {
		server.kill("SIGTERM");
		await Promise.race([server.exited, Bun.sleep(5_000)]).catch(() => {});
	}
	if (keepTemp) console.log(`Kept performance fixture: ${tempRoot}`);
	else if (existsSync(tempRoot) && basename(tempRoot).startsWith("hlid-perf-gate-")) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
