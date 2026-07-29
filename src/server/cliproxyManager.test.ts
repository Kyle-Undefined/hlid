import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "hlid-cliproxy-test-"));
	temporaryRoots.push(root);
	return root;
}

function managedConfig() {
	return HlidConfigSchema.parse({
		cliproxy: { enabled: true, mode: "managed" },
	}).cliproxy;
}

function writePriorInstall(root: string) {
	const installDir = join(root, "versions", "7.2.87-prior");
	const executable = join(installDir, "cli-proxy-api.exe");
	const linuxExecutable = join(installDir, "cli-proxy-api");
	mkdirSync(installDir, { recursive: true });
	writeFileSync(executable, "prior-windows");
	writeFileSync(linuxExecutable, "prior-linux");
	const prior = {
		version: "7.2.87",
		installDir,
		executable,
		linuxExecutable,
		clientKey: "retained-client-key",
	};
	writeFileSync(join(root, "managed.json"), JSON.stringify(prior, null, 2));
	return prior;
}

function createInstallOperations(
	options: {
		windowsExitCode?: number;
		linuxExitCode?: number;
		windowsChecksumMatches?: boolean;
	} = {},
) {
	const windowsArchive = Buffer.from("verified-windows-archive");
	const linuxArchive = Buffer.from("verified-linux-archive");
	const digest = (value: Buffer) =>
		createHash("sha256").update(value).digest("hex");
	const windowsRelease = {
		version: "test-version",
		archiveName: "cliproxy.zip",
		downloadUrl: "https://example.test/cliproxy.zip",
		sha256:
			options.windowsChecksumMatches === false
				? "0".repeat(64)
				: digest(windowsArchive),
	};
	const linuxRelease = {
		version: "test-version",
		archiveName: "cliproxy.tar.gz",
		downloadUrl: "https://example.test/cliproxy.tar.gz",
		sha256: digest(linuxArchive),
	};
	const runProcess = vi.fn(
		async (executable: string, args: string[], _options: unknown) => {
			if (executable === "powershell.exe") {
				if (options.windowsExitCode !== undefined) {
					return { output: "PowerShell failed", code: options.windowsExitCode };
				}
				const command = args.at(-1) ?? "";
				const destination = command.match(/-DestinationPath '([^']+)'/)?.[1];
				if (!destination) throw new Error("missing Windows extraction path");
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, "cli-proxy-api.exe"), "windows");
				return { output: "", code: 0 };
			}
			if (options.linuxExitCode !== undefined) {
				return { output: "tar failed", code: options.linuxExitCode };
			}
			const destination = args.at(-1);
			if (!destination) throw new Error("missing Linux extraction path");
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(destination, "cli-proxy-api"), "linux");
			return { output: "", code: 0 };
		},
	);
	return {
		runProcess,
		operations: {
			release: (_arch?: NodeJS.Architecture, target = "windows") =>
				target === "linux" ? linuxRelease : windowsRelease,
			download: async (
				url: string,
				_limit: number,
				onProgress?: (received: number, total: number | null) => void,
			) => {
				const archive =
					url === linuxRelease.downloadUrl ? linuxArchive : windowsArchive;
				onProgress?.(archive.byteLength, archive.byteLength);
				return archive;
			},
			runProcess,
		},
	};
}

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

describe("managed CLIProxy installation", () => {
	it("installs both targets atomically and removes the superseded version", async () => {
		const root = temporaryRoot();
		const prior = writePriorInstall(root);
		const { operations, runProcess } = createInstallOperations();
		const manager = new CliProxyManager(
			managedConfig(),
			root,
			"win32",
			() => false,
			operations,
		);
		const stop = vi.spyOn(manager, "stop").mockResolvedValue();
		const start = vi.spyOn(manager, "start").mockResolvedValue();

		const install = manager.startInstall();

		expect(install.status.state).toBe("downloading");
		await install.completion;
		const state = JSON.parse(
			readFileSync(join(root, "managed.json"), "utf8"),
		) as {
			version: string;
			installDir: string;
			executable: string;
			linuxExecutable: string;
			clientKey: string;
		};
		expect(manager.status()).toMatchObject({
			state: "installed",
			installedVersion: "test-version",
			wslInstalled: true,
			versionMismatch: false,
		});
		expect(state).toMatchObject({
			version: "test-version",
			clientKey: prior.clientKey,
		});
		expect(existsSync(state.executable)).toBe(true);
		expect(existsSync(state.linuxExecutable)).toBe(true);
		expect(existsSync(prior.installDir)).toBe(false);
		expect(readdirSync(join(root, "versions"))).toEqual([
			basename(state.installDir),
		]);
		expect(readdirSync(root).some((entry) => entry.startsWith(".stage-"))).toBe(
			false,
		);
		expect(stop).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith(true);
		expect(runProcess).toHaveBeenCalledTimes(2);
	});

	it("restores and restarts the prior install when extraction fails", async () => {
		const root = temporaryRoot();
		const prior = writePriorInstall(root);
		const { operations } = createInstallOperations({ windowsExitCode: 1 });
		const manager = new CliProxyManager(
			managedConfig(),
			root,
			"win32",
			() => false,
			operations,
		);
		vi.spyOn(manager, "stop").mockResolvedValue();
		const start = vi.spyOn(manager, "start").mockResolvedValue();

		const install = manager.startInstall();

		await expect(install.completion).rejects.toThrow(
			"PowerShell could not extract CLIProxy",
		);
		expect(
			JSON.parse(readFileSync(join(root, "managed.json"), "utf8")),
		).toEqual(prior);
		expect(start).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith(true);
		expect(readdirSync(join(root, "versions"))).toEqual([
			basename(prior.installDir),
		]);
		expect(readdirSync(root).some((entry) => entry.startsWith(".stage-"))).toBe(
			false,
		);
	});

	it("removes a fresh install when its first startup fails", async () => {
		const root = temporaryRoot();
		const { operations } = createInstallOperations();
		const manager = new CliProxyManager(
			managedConfig(),
			root,
			"win32",
			() => false,
			operations,
		);
		vi.spyOn(manager, "stop").mockResolvedValue();
		const start = vi
			.spyOn(manager, "start")
			.mockRejectedValue(new Error("startup failed"));

		const install = manager.startInstall();

		await expect(install.completion).rejects.toThrow("startup failed");
		expect(manager.status()).toMatchObject({
			state: "error",
			error: "startup failed",
			installedVersion: undefined,
			wslInstalled: false,
		});
		expect(start).toHaveBeenCalledOnce();
		expect(existsSync(join(root, "managed.json"))).toBe(false);
		expect(existsSync(join(root, "config.yaml"))).toBe(false);
		expect(readdirSync(join(root, "versions"))).toEqual([]);
	});

	it("removes the moved version when publishing install state fails", async () => {
		const root = temporaryRoot();
		symlinkSync(join(root, "missing-auth"), join(root, "auth"), "dir");
		const { operations } = createInstallOperations();
		const manager = new CliProxyManager(
			managedConfig(),
			root,
			"win32",
			() => false,
			operations,
		);
		vi.spyOn(manager, "stop").mockResolvedValue();
		const start = vi.spyOn(manager, "start").mockResolvedValue();

		const install = manager.startInstall();

		await expect(install.completion).rejects.toThrow();
		expect(start).not.toHaveBeenCalled();
		expect(existsSync(join(root, "managed.json"))).toBe(false);
		expect(existsSync(join(root, "config.yaml"))).toBe(false);
		expect(readdirSync(join(root, "versions"))).toEqual([]);
		expect(readdirSync(root).some((entry) => entry.startsWith(".stage-"))).toBe(
			false,
		);
	});

	it("rejects an unverified archive before stopping the current install", async () => {
		const root = temporaryRoot();
		writePriorInstall(root);
		const { operations, runProcess } = createInstallOperations({
			windowsChecksumMatches: false,
		});
		const manager = new CliProxyManager(
			managedConfig(),
			root,
			"win32",
			() => false,
			operations,
		);
		const stop = vi.spyOn(manager, "stop").mockResolvedValue();

		const install = manager.startInstall();

		await expect(install.completion).rejects.toThrow(
			"download checksum did not match the approved release",
		);
		expect(stop).not.toHaveBeenCalled();
		expect(runProcess).not.toHaveBeenCalled();
		expect(manager.status().download).toBeUndefined();
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
		const root = temporaryRoot();
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
		const root = temporaryRoot();
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
		const root = temporaryRoot();
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
