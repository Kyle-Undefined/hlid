import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "../config";
import {
	approvedCliProxyRelease,
	CLIPROXY_APPROVED_VERSION,
	CLIPROXY_OAUTH_PROVIDERS,
	CliProxyManager,
	cliProxyLaunchError,
	extractCliProxyOAuthPrompt,
	managedCliProxyConfig,
	terminateCliProxyChild,
	windowsPathToWsl,
	windowsSystemExecutable,
	wslCliProxyLaunchArgs,
} from "./cliproxyManager";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("CLIProxy release verification", () => {
	it("pins the approved Windows archives and SHA-256 digests", () => {
		const x64 = approvedCliProxyRelease("x64");
		const arm64 = approvedCliProxyRelease("arm64");
		expect(x64.version).toBe(CLIPROXY_APPROVED_VERSION);
		expect(x64.archiveName).toBe("CLIProxyAPI_7.2.88_windows_amd64.zip");
		expect(x64.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(arm64.archiveName).toBe("CLIProxyAPI_7.2.88_windows_aarch64.zip");
		expect(arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("pins matching Linux archives for WSL sidecars", () => {
		const x64 = approvedCliProxyRelease("x64", "linux");
		const arm64 = approvedCliProxyRelease("arm64", "linux");
		expect(x64.archiveName).toBe("CLIProxyAPI_7.2.88_linux_amd64.tar.gz");
		expect(x64.sha256).toBe(
			"2cc3b38e3ba2474d0cdeb7a3f25b026891ba34e34d3a7e0501d4efd03c01f6fe",
		);
		expect(arm64.archiveName).toBe("CLIProxyAPI_7.2.88_linux_aarch64.tar.gz");
		expect(arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects unsupported Windows architectures", () => {
		expect(() => approvedCliProxyRelease("ia32")).toThrow(
			"managed CLIProxy does not support ia32",
		);
	});
});

describe("managed CLIProxy configuration", () => {
	it("builds safe WSL paths and direct launch arguments", () => {
		expect(windowsPathToWsl("C:\\Hlid\\cliproxy\\cli-proxy-api")).toBe(
			"/mnt/c/Hlid/cliproxy/cli-proxy-api",
		);
		const args = wslCliProxyLaunchArgs(
			"Ubuntu-24.04",
			"/mnt/c/Hlid/runtime.pid",
			"/mnt/c/Hlid/cli-proxy-api",
			"/mnt/c/Hlid/config.yaml",
		);
		expect(args.slice(0, 6)).toEqual([
			"-d",
			"Ubuntu-24.04",
			"--exec",
			"sh",
			"-c",
			expect.stringContaining('exec "$2" --config "$3"'),
		]);
		expect(() =>
			wslCliProxyLaunchArgs("Ubuntu;bad", "pid", "exe", "config"),
		).toThrow("invalid WSL distro name");
	});

	it("uses the Windows system tar instead of a PATH-shadowing executable", () => {
		expect(windowsSystemExecutable("tar.exe", "D:\\Windows")).toBe(
			"D:\\Windows\\System32\\tar.exe",
		);
	});

	it("explains when Windows Security may have removed the executable", () => {
		expect(
			cliProxyLaunchError(
				new Error("EUNKNOWN: unknown error, uv_spawn"),
				false,
				"win32",
			).message,
		).toContain("Windows Security may have quarantined it");
		expect(
			cliProxyLaunchError(new Error("spawn failed"), true, "win32").message,
		).toBe("CLIProxy could not start: spawn failed");
	});

	it("waits for a child process to exit after requesting termination", async () => {
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			kill = vi.fn(() => {
				setTimeout(() => {
					this.exitCode = 0;
					this.emit("exit", 0);
				}, 10);
				return true;
			});
		}
		const child = new FakeChild();
		await terminateCliProxyChild(
			child as unknown as import("node:child_process").ChildProcess,
			100,
		);
		expect(child.kill).toHaveBeenCalledOnce();
		expect(child.exitCode).toBe(0);
	});

	it("uses CLIProxy's device flow for OpenAI while retaining provider login commands", () => {
		expect(
			Object.fromEntries(
				CLIPROXY_OAUTH_PROVIDERS.map((provider) => [
					provider.id,
					provider.flag,
				]),
			),
		).toMatchObject({
			codex: "--codex-device-login",
			claude: "--claude-login",
			antigravity: "--antigravity-login",
			kimi: "--kimi-login",
			xai: "--xai-login",
		});
	});

	it("extracts browser and device-code prompts from CLI output", () => {
		expect(
			extractCliProxyOAuthPrompt(
				"Visit the following URL to continue authentication:\nhttps://auth.example.test/oauth?state=abc\n",
			),
		).toEqual({
			url: "https://auth.example.test/oauth?state=abc",
			code: undefined,
		});
		expect(
			extractCliProxyOAuthPrompt(
				"Starting Codex device authentication...\nCodex device URL: https://auth.example.test/device\nCodex device code: ABCD-EFGH\n",
			),
		).toEqual({
			url: "https://auth.example.test/device",
			code: "ABCD-EFGH",
		});
		expect(
			extractCliProxyOAuthPrompt(
				"To authenticate, please visit:\nhttps://auth.example.test/kimi\nUser code: KIMI-1234\n",
			),
		).toEqual({
			url: "https://auth.example.test/kimi",
			code: "KIMI-1234",
		});
		expect(
			extractCliProxyOAuthPrompt(
				"To authenticate, please visit:\nhttps://auth.example.test/xai\nThen enter this code: XAI-5678\n",
			),
		).toEqual({
			url: "https://auth.example.test/xai",
			code: "XAI-5678",
		});
	});

	it("binds loopback, disables management, and embeds only the private client key", () => {
		const yaml = managedCliProxyConfig("C:\\Hlid\\auth", "private-client-key");
		expect(yaml).toContain('host: "127.0.0.1"');
		expect(yaml).toContain('auth-dir: "C:\\\\Hlid\\\\auth"');
		expect(yaml).toContain('  - "private-client-key"');
		expect(yaml).toContain("allow-remote: false");
		expect(yaml).toContain("disable-control-panel: true");
		expect(yaml).toContain("usage-statistics-enabled: false");
	});

	it("reports every OAuth account found in the private auth directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-cliproxy-test-"));
		temporaryRoots.push(root);
		const auth = join(root, "auth");
		mkdirSync(auth);
		writeFileSync(join(auth, "openai.json"), JSON.stringify({ type: "codex" }));
		writeFileSync(
			join(auth, "anthropic.json"),
			JSON.stringify({ provider: "claude" }),
		);
		writeFileSync(
			join(auth, "moonshot.json"),
			JSON.stringify({ type: "kimi" }),
		);

		const manager = new CliProxyManager(
			HlidConfigSchema.parse({}).cliproxy,
			root,
			"win32",
		);
		await manager.initialize();
		expect(manager.status().accounts).toMatchObject({
			codex: "connected",
			claude: "connected",
			kimi: "connected",
			antigravity: "idle",
			xai: "idle",
		});
	});

	it("does not report expired or disabled OAuth files as connected", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-cliproxy-test-"));
		temporaryRoots.push(root);
		const auth = join(root, "auth");
		mkdirSync(auth);
		writeFileSync(
			join(auth, "expired-claude.json"),
			JSON.stringify({
				type: "claude",
				expired: new Date(Date.now() - 60_000).toISOString(),
			}),
		);
		writeFileSync(
			join(auth, "disabled-codex.json"),
			JSON.stringify({ type: "codex", disabled: true }),
		);

		const manager = new CliProxyManager(
			HlidConfigSchema.parse({}).cliproxy,
			root,
			"win32",
		);
		await manager.initialize();

		expect(manager.status().accounts).toMatchObject({
			claude: "idle",
			codex: "idle",
		});
	});

	it("refreshes account expiry while Hlid remains open", async () => {
		const root = mkdtempSync(join(tmpdir(), "hlid-cliproxy-test-"));
		temporaryRoots.push(root);
		const auth = join(root, "auth");
		mkdirSync(auth);
		const authPath = join(auth, "claude.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				type: "claude",
				expired: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const manager = new CliProxyManager(
			HlidConfigSchema.parse({}).cliproxy,
			root,
			"win32",
		);
		await manager.initialize();
		expect(manager.status().accounts.claude).toBe("connected");

		writeFileSync(
			authPath,
			JSON.stringify({
				type: "claude",
				expired: new Date(Date.now() - 60_000).toISOString(),
			}),
		);

		expect(manager.status().accounts.claude).toBe("idle");
	});
});
