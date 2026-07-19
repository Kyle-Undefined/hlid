import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "../config";
import {
	CLIPROXY_OAUTH_PROVIDERS,
	CliProxyManager,
	checksumForAsset,
	extractCliProxyOAuthPrompt,
	managedCliProxyConfig,
	selectCliProxyReleaseAssets,
	terminateCliProxyChild,
} from "./cliproxyManager";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("CLIProxy release verification", () => {
	it("selects the current Windows architecture and checksum manifest", () => {
		const selected = selectCliProxyReleaseAssets(
			{
				tag_name: "v7.2.88",
				assets: [
					{
						name: "CLIProxyAPI_7.2.88_windows_amd64.zip",
						browser_download_url: "https://example.test/amd64.zip",
					},
					{
						name: "CLIProxyAPI_7.2.88_windows_arm64.zip",
						browser_download_url: "https://example.test/arm64.zip",
					},
					{
						name: "checksums.txt",
						browser_download_url: "https://example.test/checksums.txt",
					},
				],
			},
			"arm64",
		);
		expect(selected.version).toBe("7.2.88");
		expect(selected.archive.name).toContain("windows_arm64.zip");
	});

	it("requires an exact SHA-256 entry for the selected archive", () => {
		const digest = "a".repeat(64);
		expect(
			checksumForAsset(
				`${digest}  CLIProxyAPI_7.2.88_windows_amd64.zip\n`,
				"CLIProxyAPI_7.2.88_windows_amd64.zip",
			),
		).toBe(digest);
		expect(() =>
			checksumForAsset(`${digest}  another.zip`, "wanted.zip"),
		).toThrow("checksum not found");
	});
});

describe("managed CLIProxy configuration", () => {
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
});
