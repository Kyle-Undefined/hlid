import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OLLAMA_WINDOWS_INSTALLER_NAME,
	OLLAMA_WINDOWS_RELEASE_API,
	OLLAMA_WINDOWS_SETUP_MAX_BYTES,
	type OllamaWindowsSetupFileSystem,
	OllamaWindowsSetupManager,
	type OllamaWindowsSetupState,
} from "./ollamaWindowsSetup";

const VERSION = "0.32.14";
const TAG = `v${VERSION}`;
const INSTALLER_URL = `https://github.com/ollama/ollama/releases/download/${TAG}/${OLLAMA_WINDOWS_INSTALLER_NAME}`;
const OFFICIAL_SIGNATURE = {
	status: "Valid",
	subject: "CN=Ollama Inc., O=Ollama Inc., L=Toronto, S=Ontario, C=CA",
};
const STAGE_ID = "01234567-89ab-4def-8123-456789abcdef";
const STAGE_NAME = `hlid-ollama-setup-${STAGE_ID}`;
const SECURITY_MODULE_IMPORT =
	'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -Force -ErrorAction Stop';
const MANAGEMENT_MODULE_IMPORT =
	'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -Force -ErrorAction Stop';
const SECURITY_COMMAND =
	"Microsoft.PowerShell.Security\\Get-AuthenticodeSignature";
const MANAGEMENT_COMMAND = "Microsoft.PowerShell.Management\\Start-Process";

const NATIVE_FILE_SYSTEM: OllamaWindowsSetupFileSystem = {
	mkdir,
	open,
	read: (path) => createReadStream(path),
	readdir,
	realpath,
	rename,
	rm,
	stat,
};

type SetupManager = OllamaWindowsSetupManager;

const managers: SetupManager[] = [];
const roots: string[] = [];

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function release(
	bytes: Uint8Array,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		tag_name: TAG,
		draft: false,
		prerelease: false,
		assets: [
			{
				name: OLLAMA_WINDOWS_INSTALLER_NAME,
				browser_download_url: INSTALLER_URL,
				digest: `sha256:${digest(bytes)}`,
				size: bytes.byteLength,
			},
		],
		...overrides,
	};
}

function responseForRelease(value: Record<string, unknown>): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function responseForInstaller(bytes: Uint8Array): Response {
	return new Response(Uint8Array.from(bytes).buffer, {
		status: 200,
		headers: {
			"content-length": String(bytes.byteLength),
			"content-type": "application/octet-stream",
		},
	});
}

function setupFetch(
	releaseValue: Record<string, unknown>,
	bytes: Uint8Array,
): typeof fetch {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url === OLLAMA_WINDOWS_RELEASE_API) {
			return responseForRelease(releaseValue);
		}
		if (url === INSTALLER_URL) return responseForInstaller(bytes);
		return new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
}

function decodedPowerShellScript(args: string[]): string {
	const encodedIndex = args.indexOf("-EncodedCommand");
	const encoded = args[encodedIndex + 1];
	if (encodedIndex < 0 || !encoded) {
		throw new Error("missing PowerShell encoded command");
	}
	return Buffer.from(encoded, "base64").toString("utf16le");
}

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hlid-ollama-setup-test-"));
	roots.push(path);
	return path;
}

function manager(
	options: ConstructorParameters<typeof OllamaWindowsSetupManager>[0],
): OllamaWindowsSetupManager {
	let now = 1_000;
	const created = new OllamaWindowsSetupManager({
		platform: "win32",
		randomId: () => STAGE_ID,
		now: () => ++now,
		...options,
	});
	managers.push(created);
	return created;
}

async function waitForPhase<T extends OllamaWindowsSetupState["phase"]>(
	setup: OllamaWindowsSetupManager,
	phase: T,
): Promise<Extract<OllamaWindowsSetupState, { phase: T }>> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const state = setup.status();
		if (state.phase === phase) {
			return state as Extract<OllamaWindowsSetupState, { phase: T }>;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Ollama setup never reached ${phase}`);
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((setup) => setup.close()));
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
	vi.restoreAllMocks();
});

describe("OllamaWindowsSetupManager", () => {
	it("downloads in the background, verifies twice, launches interactively, and cleans up when detected", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const fetcher = setupFetch(release(bytes), bytes);
		const verifyAuthenticode = vi.fn(async () => OFFICIAL_SIGNATURE);
		const launcher = vi.fn(async () => {});
		const stagingRoot = await root();
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			verifyAuthenticode,
			launcher,
		});

		expect(setup.startDownload()).toMatchObject({ phase: "resolving" });
		const ready = await waitForPhase(setup, "ready");
		expect(ready).toMatchObject({ version: VERSION, bytes: bytes.byteLength });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(verifyAuthenticode).toHaveBeenCalledOnce();
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);

		await expect(setup.launch()).resolves.toMatchObject({
			phase: "launched",
			version: VERSION,
		});
		expect(verifyAuthenticode).toHaveBeenCalledTimes(2);
		expect(launcher).toHaveBeenCalledWith(
			join(stagingRoot, `${STAGE_NAME}.exe`),
		);

		await expect(setup.markDetected(VERSION)).resolves.toMatchObject({
			phase: "complete",
			version: VERSION,
		});
		expect(await readdir(stagingRoot)).toEqual([]);
	});

	it("pins signature and launcher commands to the built-in Windows PowerShell modules", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const scripts: string[] = [];
		const runProcess = vi.fn(async (_executable: string, args: string[]) => {
			const script = decodedPowerShellScript(args);
			scripts.push(script);
			if (script.includes(SECURITY_COMMAND)) {
				return {
					code: 0,
					output: JSON.stringify({
						Status: OFFICIAL_SIGNATURE.status,
						Subject: OFFICIAL_SIGNATURE.subject,
					}),
				};
			}
			if (script.includes(MANAGEMENT_COMMAND)) {
				return { code: 0, output: "4321" };
			}
			throw new Error("unexpected PowerShell command");
		});
		const setup = manager({
			root: await root(),
			fetch: setupFetch(release(bytes), bytes),
			runProcess,
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		await expect(setup.launch()).resolves.toMatchObject({ phase: "launched" });

		const signatureScripts = scripts.filter((script) =>
			script.includes(SECURITY_COMMAND),
		);
		expect(signatureScripts).toHaveLength(2);
		for (const script of signatureScripts) {
			expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
			expect(script.indexOf(SECURITY_MODULE_IMPORT)).toBeGreaterThanOrEqual(0);
			expect(script.indexOf(SECURITY_MODULE_IMPORT)).toBeLessThan(
				script.indexOf(SECURITY_COMMAND),
			);
		}
		const launcherScript = scripts.find((script) =>
			script.includes(MANAGEMENT_COMMAND),
		);
		expect(launcherScript).toBeDefined();
		expect(launcherScript).toContain(
			"$ProgressPreference = 'SilentlyContinue'",
		);
		expect(
			launcherScript?.indexOf(MANAGEMENT_MODULE_IMPORT),
		).toBeGreaterThanOrEqual(0);
		expect(launcherScript?.indexOf(MANAGEMENT_MODULE_IMPORT)).toBeLessThan(
			launcherScript?.indexOf(MANAGEMENT_COMMAND) ?? -1,
		);
		expect(runProcess).toHaveBeenCalledTimes(3);
	});

	it("retains a SHA-verified installer across process and response failures and retries without downloading", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const fetcher = setupFetch(release(bytes), bytes);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let verificationAttempt = 0;
		const runProcess = vi.fn(async (_executable: string, args: string[]) => {
			const script = decodedPowerShellScript(args);
			if (!script.includes(SECURITY_COMMAND)) {
				throw new Error("unexpected PowerShell command");
			}
			verificationAttempt += 1;
			if (verificationAttempt === 1) {
				return { code: 1, output: "sensitive module-loading details" };
			}
			if (verificationAttempt === 2) {
				return { code: 0, output: "not JSON" };
			}
			return {
				code: 0,
				output: JSON.stringify({
					Status: OFFICIAL_SIGNATURE.status,
					Subject: OFFICIAL_SIGNATURE.subject,
				}),
			};
		});
		const stagingRoot = await root();
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			runProcess,
		});

		setup.startDownload();
		const processFailure = await waitForPhase(setup, "verification_failed");
		expect(processFailure.reason).toBe(
			"Ollama installer signature verification failed",
		);
		expect(processFailure.reason).not.toContain("module-loading");
		expect(warn).toHaveBeenNthCalledWith(
			1,
			"[ollama setup] Authenticode verifier infrastructure failure (exit-code-1)",
		);
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);

		expect(setup.startDownload()).toMatchObject({ phase: "verifying" });
		const responseFailure = await waitForPhase(setup, "verification_failed");
		expect(responseFailure.reason).toBe(
			"Ollama installer signature response is invalid",
		);
		expect(warn).toHaveBeenNthCalledWith(
			2,
			"[ollama setup] Authenticode verifier infrastructure failure (invalid-response)",
		);
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);

		expect(setup.startDownload()).toMatchObject({ phase: "verifying" });
		await waitForPhase(setup, "ready");
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(runProcess).toHaveBeenCalledTimes(3);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);
	});

	it("removes abandoned installer staging files before a new download", async () => {
		const bytes = new TextEncoder().encode("installer");
		const stagingRoot = await root();
		await writeFile(
			join(
				stagingRoot,
				"hlid-ollama-setup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.part",
			),
			"partial",
		);
		await writeFile(
			join(
				stagingRoot,
				"hlid-ollama-setup-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.exe",
			),
			"old installer",
		);
		await writeFile(
			join(stagingRoot, "hlid-ollama-setup-not-a-uuid.exe"),
			"not Hlid staging",
		);
		await writeFile(join(stagingRoot, "unowned.exe"), "not Hlid staging");
		await writeFile(join(stagingRoot, "keep.txt"), "not setup staging");
		const setup = manager({
			root: stagingRoot,
			fetch: setupFetch(release(bytes), bytes),
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		expect((await readdir(stagingRoot)).sort()).toEqual([
			`${STAGE_NAME}.exe`,
			"hlid-ollama-setup-not-a-uuid.exe",
			"keep.txt",
			"unowned.exe",
		]);
	});

	it("rejects a staging root that resolves through a symlink or junction", async () => {
		const bytes = new TextEncoder().encode("installer");
		const stagingRoot = await root();
		const outside = await root();
		const outsideArtifact = join(
			outside,
			"hlid-ollama-setup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.exe",
		);
		await writeFile(outsideArtifact, "unowned outside executable");
		await rm(stagingRoot, { recursive: true, force: true });
		await symlink(outside, stagingRoot, "dir");
		const fetcher = setupFetch(release(bytes), bytes);
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await expect(waitForPhase(setup, "failed")).resolves.toMatchObject({
			reason: expect.stringContaining("symbolic link or junction"),
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect(await readdir(outside)).toEqual([
			"hlid-ollama-setup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.exe",
		]);
	});

	it("retains a verified installer when Windows launch fails so launch can be retried", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const stagingRoot = await root();
		const launcher = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("temporary shell failure"))
			.mockResolvedValueOnce();
		const verifyAuthenticode = vi.fn(async () => OFFICIAL_SIGNATURE);
		const setup = manager({
			root: stagingRoot,
			fetch: setupFetch(release(bytes), bytes),
			verifyAuthenticode,
			launcher,
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		await expect(setup.launch()).rejects.toThrow("temporary shell failure");
		expect(setup.status()).toMatchObject({ phase: "ready", version: VERSION });
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);

		await expect(setup.launch()).resolves.toMatchObject({ phase: "launched" });
		expect(launcher).toHaveBeenCalledTimes(2);
		expect(verifyAuthenticode).toHaveBeenCalledTimes(3);
	});

	it("retains the installer when launch-time signature inspection cannot run", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const stagingRoot = await root();
		const fetcher = setupFetch(release(bytes), bytes);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const verifyAuthenticode = vi
			.fn<() => Promise<typeof OFFICIAL_SIGNATURE>>()
			.mockResolvedValueOnce(OFFICIAL_SIGNATURE)
			.mockRejectedValueOnce(new Error("sensitive verifier failure"))
			.mockResolvedValue(OFFICIAL_SIGNATURE);
		const launcher = vi.fn(async () => {});
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			verifyAuthenticode,
			launcher,
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		await expect(setup.launch()).resolves.toMatchObject({
			phase: "verification_failed",
			reason: "Ollama installer signature verification could not run",
		});
		expect(launcher).not.toHaveBeenCalled();
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);
		expect(warn).toHaveBeenCalledWith(
			"[ollama setup] Authenticode verifier infrastructure failure (verifier-error)",
		);

		expect(setup.startDownload()).toMatchObject({ phase: "verifying" });
		await waitForPhase(setup, "ready");
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(verifyAuthenticode).toHaveBeenCalledTimes(3);
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);
	});

	it("keeps a locked staged installer referenced and retries cleanup after detection", async () => {
		const bytes = new TextEncoder().encode("signed Ollama installer");
		const stagingRoot = await root();
		let locked = true;
		const fileSystem: OllamaWindowsSetupFileSystem = {
			...NATIVE_FILE_SYSTEM,
			rm: async (path, options) => {
				if (locked && path.endsWith(".exe")) {
					throw new Error("EPERM: installer is still running");
				}
				await rm(path, options);
			},
		};
		const setup = manager({
			root: stagingRoot,
			fs: fileSystem,
			fetch: setupFetch(release(bytes), bytes),
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		await expect(setup.markDetected(VERSION)).resolves.toMatchObject({
			phase: "complete",
		});
		expect(await readdir(stagingRoot)).toEqual([`${STAGE_NAME}.exe`]);

		locked = false;
		await setup.markDetected(VERSION);
		expect(await readdir(stagingRoot)).toEqual([]);
	});

	it("requires one exact official release asset with a GitHub SHA-256 digest", async () => {
		const bytes = new TextEncoder().encode("installer");
		const base = release(bytes);
		const cases: Array<[string, Record<string, unknown>]> = [
			[
				"unofficial URL",
				{
					...base,
					assets: [
						{
							...(base.assets as Record<string, unknown>[])[0],
							browser_download_url:
								"https://downloads.example.test/OllamaSetup.exe",
						},
					],
				},
			],
			[
				"missing digest",
				{
					...base,
					assets: [
						{
							...(base.assets as Record<string, unknown>[])[0],
							digest: null,
						},
					],
				},
			],
			[
				"duplicate installer",
				{
					...base,
					assets: [
						(base.assets as Record<string, unknown>[])[0],
						(base.assets as Record<string, unknown>[])[0],
					],
				},
			],
			["prerelease", { ...base, prerelease: true }],
		];

		for (const [label, value] of cases) {
			const setup = manager({
				root: await root(),
				fetch: setupFetch(value, bytes),
				verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
				launcher: vi.fn(async () => {}),
			});
			setup.startDownload();
			const failed = await waitForPhase(setup, "failed");
			expect(failed.reason, label).toMatch(
				/official release asset|SHA-256 digest|exactly one|not stable/,
			);
		}
	});

	it("rejects release metadata above the three GiB cap before downloading", async () => {
		const bytes = new Uint8Array([1]);
		const value = release(bytes);
		const asset = (value.assets as Record<string, unknown>[])[0];
		if (!asset) throw new Error("missing release asset fixture");
		asset.size = OLLAMA_WINDOWS_SETUP_MAX_BYTES + 1;
		const fetcher = setupFetch(value, bytes);
		const setup = manager({
			root: await root(),
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await expect(waitForPhase(setup, "failed")).resolves.toMatchObject({
			reason: expect.stringContaining("safety limit"),
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("rejects a digest mismatch and removes the partial installer", async () => {
		const expected = new TextEncoder().encode("expected");
		const downloaded = new TextEncoder().encode("tampered");
		const stagingRoot = await root();
		const verifyAuthenticode = vi.fn(async () => OFFICIAL_SIGNATURE);
		const setup = manager({
			root: stagingRoot,
			fetch: setupFetch(release(expected), downloaded),
			verifyAuthenticode,
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await expect(waitForPhase(setup, "failed")).resolves.toMatchObject({
			reason: expect.stringContaining("digest did not match"),
		});
		expect(verifyAuthenticode).not.toHaveBeenCalled();
		expect(await readdir(stagingRoot)).toEqual([]);
	});

	it("requires an exact valid Ollama Inc. Authenticode signer", async () => {
		const bytes = new TextEncoder().encode("installer");
		for (const signature of [
			{ status: "NotSigned", subject: null },
			{ status: "Valid", subject: "CN=Fake, O=Not Ollama Inc., C=US" },
			{ status: "Valid", subject: "CN=Ollama Inc., O=Ollama Incubator, C=US" },
		]) {
			const stagingRoot = await root();
			const setup = manager({
				root: stagingRoot,
				fetch: setupFetch(release(bytes), bytes),
				verifyAuthenticode: vi.fn(async () => signature),
				launcher: vi.fn(async () => {}),
			});
			setup.startDownload();
			await expect(waitForPhase(setup, "failed")).resolves.toMatchObject({
				reason: expect.stringContaining("valid Authenticode signature"),
			});
			expect(await readdir(stagingRoot)).toEqual([]);
		}
	});

	it("revalidates containment, hash, and signature immediately before launch", async () => {
		const bytes = new TextEncoder().encode("installer bytes");
		const stagingRoot = await root();
		const verifyAuthenticode = vi.fn(async () => OFFICIAL_SIGNATURE);
		const launcher = vi.fn(async () => {});
		const setup = manager({
			root: stagingRoot,
			fetch: setupFetch(release(bytes), bytes),
			verifyAuthenticode,
			launcher,
		});

		setup.startDownload();
		await waitForPhase(setup, "ready");
		const artifact = join(stagingRoot, `${STAGE_NAME}.exe`);
		const outside = join(await root(), "outside.exe");
		await writeFile(outside, bytes);
		await unlink(artifact);
		await symlink(outside, artifact);

		await expect(setup.launch()).resolves.toMatchObject({
			phase: "failed",
			reason: expect.stringContaining("escaped"),
		});
		expect(verifyAuthenticode).toHaveBeenCalledOnce();
		expect(launcher).not.toHaveBeenCalled();
	});

	it("coalesces repeated starts into one background download", async () => {
		const bytes = new TextEncoder().encode("installer");
		let resolveRelease: (response: Response) => void = () => {
			throw new Error("missing release resolver");
		};
		const pendingRelease = new Promise<Response>((resolve) => {
			resolveRelease = resolve;
		});
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			if (String(input) === OLLAMA_WINDOWS_RELEASE_API) return pendingRelease;
			return responseForInstaller(bytes);
		}) as unknown as typeof fetch;
		const setup = manager({
			root: await root(),
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		expect(setup.startDownload().phase).toBe("resolving");
		expect(setup.startDownload().phase).toBe("resolving");
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		resolveRelease(responseForRelease(release(bytes)));
		await waitForPhase(setup, "ready");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("cancels an active fetch and cleans partial staging", async () => {
		const bytes = new TextEncoder().encode("installer");
		const fetcher = vi.fn(
			async (
				input: string | URL | Request,
				init?: RequestInit,
			): Promise<Response> => {
				if (String(input) === OLLAMA_WINDOWS_RELEASE_API) {
					return responseForRelease(release(bytes));
				}
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return reject(new Error("missing download signal"));
					const stop = () => reject(signal.reason);
					if (signal.aborted) stop();
					else signal.addEventListener("abort", stop, { once: true });
				});
			},
		) as unknown as typeof fetch;
		const stagingRoot = await root();
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await waitForPhase(setup, "downloading");
		await expect(setup.cancelDownload()).resolves.toMatchObject({
			phase: "canceled",
		});
		expect(await readdir(stagingRoot)).toEqual([]);
	});

	it("close aborts work, cleans staging, and prevents later starts", async () => {
		const bytes = new TextEncoder().encode("installer");
		const fetcher = vi.fn(
			async (
				input: string | URL | Request,
				init?: RequestInit,
			): Promise<Response> => {
				if (String(input) === OLLAMA_WINDOWS_RELEASE_API) {
					return responseForRelease(release(bytes));
				}
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return reject(new Error("missing download signal"));
					const stop = () => reject(signal.reason);
					if (signal.aborted) stop();
					else signal.addEventListener("abort", stop, { once: true });
				});
			},
		) as unknown as typeof fetch;
		const stagingRoot = await root();
		const setup = manager({
			root: stagingRoot,
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		setup.startDownload();
		await waitForPhase(setup, "downloading");
		await setup.close();
		expect(setup.status()).toEqual({ phase: "idle" });
		expect(await readdir(stagingRoot)).toEqual([]);
		expect(() => setup.startDownload()).toThrow("closed");
	});

	it("does not turn a pre-existing or failed installation into setup completion", async () => {
		const setup = manager({
			root: await root(),
			fetch: vi.fn() as unknown as typeof fetch,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});

		await expect(setup.markDetected("0.31.0")).resolves.toEqual({
			phase: "idle",
		});
	});

	it("rejects setup outside a Windows host without starting any work", async () => {
		const fetcher = vi.fn() as unknown as typeof fetch;
		const setup = new OllamaWindowsSetupManager({
			platform: "linux",
			root: await root(),
			fetch: fetcher,
			verifyAuthenticode: vi.fn(async () => OFFICIAL_SIGNATURE),
			launcher: vi.fn(async () => {}),
		});
		managers.push(setup);

		expect(() => setup.startDownload()).toThrow("only on Windows");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
