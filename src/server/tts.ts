import { createHash, randomBytes } from "node:crypto";
import {
	createWriteStream,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import {
	mkdir as mkdirAsync,
	rm as rmAsync,
	writeFile as writeFileAsync,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HlidConfig } from "../config";
import { replaceRuntimeDirectory } from "./embeddedRuntime";
import { INTERNAL_TTS_RUNTIME_FLAG } from "./tts-runtime";
import {
	getTtsModelDefinition,
	TTS_MODEL_DEFINITIONS,
	type TtsModelDefinition,
	type TtsVoiceInfo,
} from "./ttsModels";

export type { TtsVoiceInfo } from "./ttsModels";

export type TtsModelInfo = {
	id: string;
	label: string;
	description: string;
	tier: "fast" | "balanced" | "quality";
	sizeBytes: number;
	runtimeSizeBytes: number;
	installed: boolean;
	recommended: boolean;
	quantized: boolean;
	language: string;
	license: string;
	voices: TtsVoiceInfo[];
};

export type TtsRuntimeState =
	| "disabled"
	| "unconfigured"
	| "unavailable"
	| "loading"
	| "ready"
	| "error";

export type TtsStatus = {
	state: TtsRuntimeState;
	model: string;
	loadedModel?: string;
	backend?: "cpu";
	runtime?: string;
	runtimeVersion?: string;
	error?: string;
	download?: {
		model: string;
		item: "runtime" | "model";
		received: number;
		total: number | null;
	};
};

export type TtsSynthesisResult = {
	audio: Uint8Array;
	synthesisMs?: number;
	durationMs?: number;
};

type RuntimeDefinition = {
	id: string;
	archiveUrl: string;
	archiveSha256: string;
	archiveMaxBytes: number;
	addon: string;
	files: readonly string[];
};

type TtsRuntime = {
	process: ReturnType<typeof Bun.spawn>;
	port: number;
	token: string;
	model: string;
	threads: number;
	version: string;
};

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type TtsManagerOptions = {
	dataDir?: string;
	fetcher?: FetchLike;
	spawn?: typeof Bun.spawn;
	runtimeCommand?: (args: readonly string[]) => string[];
};

const MIB = 1024 * 1024;
const TTS_RUNTIME_VERSION = "1.13.4";
const TTS_RUNTIME_DOWNLOAD_BYTES = 8_661_664;
const MAX_RUNTIME_LOG_CHARS = 32 * 1024;

function runtimeDefinition(): RuntimeDefinition {
	if (process.platform === "win32" && process.arch === "x64") {
		return {
			id: `sherpa-onnx-${TTS_RUNTIME_VERSION}-win-x64`,
			archiveUrl: `https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${TTS_RUNTIME_VERSION}.tgz`,
			archiveSha256:
				"c180199ee4ed16a25b8ed50e2706a2d3dbe1aaa8b0699ea7d249288290c7998e",
			archiveMaxBytes: 16 * MIB,
			addon: "sherpa-onnx.node",
			files: [
				"sherpa-onnx.node",
				"sherpa-onnx-c-api.dll",
				"onnxruntime.dll",
				"onnxruntime_providers_shared.dll",
			],
		};
	}
	if (process.platform === "linux" && process.arch === "x64") {
		return {
			id: `sherpa-onnx-${TTS_RUNTIME_VERSION}-linux-x64`,
			archiveUrl: `https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-${TTS_RUNTIME_VERSION}.tgz`,
			archiveSha256:
				"a139f26eb19c30af9ef29a5390bd5f31baed8d93b20ee5eb63c6c4f339bbb059",
			archiveMaxBytes: 16 * MIB,
			addon: "sherpa-onnx.node",
			files: [
				"sherpa-onnx.node",
				"libsherpa-onnx-c-api.so",
				"libonnxruntime.so",
			],
		};
	}
	throw new Error(
		`local neural read aloud is unavailable on ${process.platform}-${process.arch}`,
	);
}

function defaultTtsDataDir(): string {
	if (process.platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
			"hlid",
			"tts",
		);
	}
	return join(
		process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
		"hlid",
		"tts",
	);
}

function installedDirectory(
	directory: string,
	hash: string,
	requiredFiles: readonly string[],
): string | null {
	try {
		if (readFileSync(join(directory, ".hash"), "utf8").trim() !== hash)
			return null;
		for (const name of requiredFiles) {
			const candidate = join(directory, name);
			if (!lstatSync(candidate).isFile()) return null;
			const canonical = realpathSync(candidate);
			const rel = relative(realpathSync(directory), canonical);
			if (rel.startsWith("..") || isAbsolute(rel)) return null;
		}
		return realpathSync(directory);
	} catch {
		return null;
	}
}

export function validateTtsArchiveEntries(
	listing: string,
	expectedRoot: string,
): string[] {
	const entries = listing
		.split(/\r?\n/)
		.map((entry) => entry.trim().replaceAll("\\", "/"))
		.filter(Boolean);
	if (entries.length === 0) throw new Error("TTS archive is empty");
	for (const entry of entries) {
		if (
			entry.startsWith("/") ||
			/^[A-Za-z]:\//.test(entry) ||
			entry.split("/").includes("..") ||
			(entry !== expectedRoot && !entry.startsWith(`${expectedRoot}/`))
		) {
			throw new Error(`unsafe TTS archive entry: ${entry}`);
		}
	}
	return entries;
}

export function relativeTtsArchivePath(
	fromDirectory: string,
	archive: string,
): string {
	const path = relative(fromDirectory, archive).replaceAll("\\", "/");
	if (!path || isAbsolute(path) || /^[A-Za-z]:\//.test(path))
		throw new Error("TTS archive must be on the same drive as its extraction");
	return path;
}

export function ttsArchiveExtractionArgs(
	fromDirectory: string,
	archive: string,
	compression: "gzip" | "bzip2",
): string[] {
	return [
		compression === "gzip" ? "-xzf" : "-xjf",
		relativeTtsArchivePath(fromDirectory, archive),
	];
}

export function ttsTarExecutable(
	platform = process.platform,
	systemRoot = process.env.SystemRoot,
): string {
	return platform === "win32"
		? win32.join(systemRoot?.trim() || "C:\\Windows", "System32", "tar.exe")
		: "tar";
}

async function tarOutput(args: string[], cwd: string): Promise<string> {
	const process = Bun.spawn([ttsTarExecutable(), ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0)
		throw new Error(
			`TTS archive command failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
		);
	return stdout;
}

function runtimeEnvironment(directory: string): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const separator = process.platform === "win32" ? ";" : ":";
	env.PATH = `${directory}${separator}${env.PATH ?? ""}`;
	if (process.platform === "linux")
		env.LD_LIBRARY_PATH = `${directory}:${env.LD_LIBRARY_PATH ?? ""}`;
	return env;
}

function drainRuntimeLog(process: ReturnType<typeof Bun.spawn>): () => string {
	let captured = "";
	const stderr = process.stderr;
	if (!(stderr instanceof ReadableStream)) return () => captured;
	const reader = stderr.getReader();
	const decoder = new TextDecoder();
	void (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				captured = (captured + decoder.decode(value, { stream: true })).slice(
					-MAX_RUNTIME_LOG_CHARS,
				);
			}
		} catch {
			// The child can close its pipe while Hlid is stopping it.
		}
	})();
	return () => captured;
}

function defaultRuntimeCommand(args: readonly string[]): string[] {
	if (process.execPath.toLowerCase().endsWith(".exe"))
		return [process.execPath, ...args];
	const entrypoint = process.argv[1];
	if (!entrypoint) throw new Error("cannot resolve Hlid server entrypoint");
	return [process.execPath, entrypoint, ...args];
}

export class TtsModelManager {
	private config: HlidConfig["voice"];
	private readonly dataDir: string;
	private readonly fetcher: FetchLike;
	private readonly spawn: typeof Bun.spawn;
	private readonly runtimeCommand: (args: readonly string[]) => string[];
	private runtime: TtsRuntime | null = null;
	private loadGeneration = 0;
	private statusValue: TtsStatus;
	private downloadAbort: AbortController | null = null;
	private synthesis: Promise<unknown> = Promise.resolve();
	private pendingSynthesis = 0;

	constructor(config: HlidConfig["voice"], options: TtsManagerOptions = {}) {
		this.config = config;
		this.dataDir = options.dataDir ?? defaultTtsDataDir();
		this.fetcher = options.fetcher ?? fetch;
		this.spawn = options.spawn ?? Bun.spawn;
		this.runtimeCommand = options.runtimeCommand ?? defaultRuntimeCommand;
		this.statusValue = {
			state:
				config.read_aloud_provider === "neural" ? "unconfigured" : "disabled",
			model: config.tts_model,
		};
	}

	status(): TtsStatus {
		return { ...this.statusValue };
	}

	models(): TtsModelInfo[] {
		return TTS_MODEL_DEFINITIONS.map((model) => ({
			id: model.id,
			label: model.label,
			description: model.description,
			tier: model.tier,
			sizeBytes: model.sizeBytes,
			runtimeSizeBytes: TTS_RUNTIME_DOWNLOAD_BYTES,
			recommended: model.recommended,
			quantized: model.quantized,
			language: model.language,
			license: model.license,
			voices: [...model.voices],
			installed: this.installedModelDir(model) !== null,
		}));
	}

	private runtimeDir(): string {
		return join(this.dataDir, "runtime", runtimeDefinition().id);
	}

	private modelDir(model: TtsModelDefinition): string {
		return join(this.dataDir, "models", model.id);
	}

	private installedRuntimeDir(): string | null {
		const definition = runtimeDefinition();
		return installedDirectory(
			this.runtimeDir(),
			definition.archiveSha256,
			definition.files,
		);
	}

	private installedModelDir(model: TtsModelDefinition): string | null {
		return installedDirectory(
			this.modelDir(model),
			model.archiveSha256,
			model.requiredFiles,
		);
	}

	async initialize(): Promise<void> {
		if (this.config.read_aloud_provider !== "neural") return;
		const model = getTtsModelDefinition(this.config.tts_model);
		if (
			!model ||
			!this.installedModelDir(model) ||
			!this.installedRuntimeDir()
		) {
			this.statusValue = {
				state: "unconfigured",
				model: this.config.tts_model,
			};
			return;
		}
		await this.load(model.id);
	}

	async syncConfig(config: HlidConfig["voice"]): Promise<void> {
		const prior = this.config;
		this.config = config;
		if (config.read_aloud_provider !== "neural") {
			this.closeRuntime();
			this.statusValue = { state: "disabled", model: config.tts_model };
			return;
		}
		const model = getTtsModelDefinition(config.tts_model);
		if (
			!model ||
			!this.installedModelDir(model) ||
			!this.installedRuntimeDir()
		) {
			this.closeRuntime();
			this.statusValue = {
				state: "unconfigured",
				model: config.tts_model,
			};
			return;
		}
		if (
			!this.runtime ||
			prior.tts_model !== config.tts_model ||
			prior.tts_threads !== config.tts_threads
		)
			await this.load(config.tts_model);
	}

	private closeRuntime(): void {
		this.loadGeneration++;
		this.runtime?.process.kill();
		this.runtime = null;
	}

	private async startRuntime(
		model: string,
		generation: number,
	): Promise<TtsRuntime> {
		const modelDefinition = getTtsModelDefinition(model);
		if (!modelDefinition) throw new Error("unknown TTS model");
		const runtimeDir = this.installedRuntimeDir();
		const modelDir = this.installedModelDir(modelDefinition);
		if (!runtimeDir || !modelDir)
			throw new Error("local neural voice files are not installed");
		const definition = runtimeDefinition();
		const port = 24_000 + Math.floor(Math.random() * 8_000);
		const token = randomBytes(32).toString("hex");
		const childArgs = [
			INTERNAL_TTS_RUNTIME_FLAG,
			"--port",
			String(port),
			"--token",
			token,
			"--addon",
			join(runtimeDir, definition.addon),
			"--model-dir",
			modelDir,
			"--model-id",
			model,
			"--threads",
			String(this.config.tts_threads),
		];
		const command = this.runtimeCommand(childArgs);
		const process = this.spawn(command, {
			cwd: runtimeDir,
			env: runtimeEnvironment(runtimeDir),
			stdout: "ignore",
			stderr: "pipe",
			windowsHide: true,
		});
		const log = drainRuntimeLog(process);
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (generation !== this.loadGeneration) {
				process.kill();
				throw new DOMException("TTS load cancelled", "AbortError");
			}
			if (process.exitCode !== null) {
				const detail = log().trim().split(/\r?\n/).at(-1);
				throw new Error(
					`TTS runtime exited with code ${process.exitCode}${detail ? `: ${detail}` : ""}`,
				);
			}
			try {
				const response = await this.fetcher(`http://127.0.0.1:${port}/status`, {
					headers: { authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(500),
				});
				if (response.ok) {
					const status = (await response.json()) as { version?: string };
					return {
						process,
						port,
						token,
						model,
						threads: this.config.tts_threads,
						version: status.version ?? TTS_RUNTIME_VERSION,
					};
				}
			} catch {
				// The child has not bound its loopback port yet.
			}
			await Bun.sleep(100);
		}
		process.kill();
		throw new Error("TTS runtime load timed out");
	}

	async load(model: string): Promise<void> {
		if (!getTtsModelDefinition(model)) throw new Error("unknown TTS model");
		const generation = ++this.loadGeneration;
		const previous = this.runtime;
		this.statusValue = {
			state: "loading",
			model,
			loadedModel: previous?.model,
		};
		try {
			const next = await this.startRuntime(model, generation);
			if (generation !== this.loadGeneration) {
				next.process.kill();
				return;
			}
			this.runtime = next;
			previous?.process.kill();
			this.statusValue = {
				state: "ready",
				model,
				loadedModel: model,
				backend: "cpu",
				runtime: "sherpa-onnx",
				runtimeVersion: next.version,
			};
		} catch (error) {
			if (generation !== this.loadGeneration) return;
			this.runtime = previous;
			this.statusValue = previous
				? {
						state: "ready",
						model,
						loadedModel: previous.model,
						backend: "cpu",
						runtime: "sherpa-onnx",
						runtimeVersion: previous.version,
						error: error instanceof Error ? error.message : String(error),
					}
				: {
						state: "error",
						model,
						error: error instanceof Error ? error.message : String(error),
					};
		}
	}

	private async downloadFile(
		url: string,
		destination: string,
		expectedSha256: string,
		maxBytes: number,
		model: string,
		item: "runtime" | "model",
		abort: AbortController,
	): Promise<void> {
		const response = await this.fetcher(url, { signal: abort.signal });
		if (!response.ok || !response.body)
			throw new Error(`TTS ${item} download failed: HTTP ${response.status}`);
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes)
			throw new Error(`TTS ${item} archive exceeds the size limit`);
		const total = Number.isFinite(declared) && declared > 0 ? declared : null;
		const hash = createHash("sha256");
		let received = 0;
		const progress = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				received += chunk.byteLength;
				if (received > maxBytes) {
					callback(new Error(`TTS ${item} archive exceeds the size limit`));
					return;
				}
				hash.update(chunk);
				this.statusValue.download = { model, item, received, total };
				callback(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body as never),
			progress,
			createWriteStream(destination, { flags: "wx" }),
		);
		const actual = hash.digest("hex");
		if (actual !== expectedSha256)
			throw new Error(
				`TTS ${item} checksum mismatch: expected ${expectedSha256}, received ${actual}`,
			);
	}

	private async installRuntime(
		abort: AbortController,
		modelId: string,
	): Promise<void> {
		if (this.installedRuntimeDir()) return;
		const definition = runtimeDefinition();
		const downloads = join(this.dataDir, "downloads");
		mkdirSync(downloads, { recursive: true });
		const archiveName = `${definition.id}.${Date.now()}.tgz.part`;
		const archive = join(downloads, archiveName);
		const temp = `${this.runtimeDir()}.tmp`;
		const extracted = join(temp, "package");
		await rmAsync(archive, { force: true });
		await rmAsync(temp, { recursive: true, force: true });
		try {
			await this.downloadFile(
				definition.archiveUrl,
				archive,
				definition.archiveSha256,
				definition.archiveMaxBytes,
				modelId,
				"runtime",
				abort,
			);
			validateTtsArchiveEntries(
				await tarOutput(["-tzf", archiveName], downloads),
				"package",
			);
			await mkdirAsync(temp, { recursive: true });
			await tarOutput(ttsArchiveExtractionArgs(temp, archive, "gzip"), temp);
			await writeFileAsync(
				join(extracted, ".hash"),
				definition.archiveSha256,
				"utf8",
			);
			if (
				!installedDirectory(
					extracted,
					definition.archiveSha256,
					definition.files,
				)
			)
				throw new Error("TTS runtime archive is missing reviewed files");
			replaceRuntimeDirectory(extracted, this.runtimeDir());
		} finally {
			await rmAsync(archive, { force: true });
			await rmAsync(temp, { recursive: true, force: true });
		}
	}

	private async installModel(
		model: TtsModelDefinition,
		abort: AbortController,
	): Promise<void> {
		if (this.installedModelDir(model)) return;
		const downloads = join(this.dataDir, "downloads");
		mkdirSync(downloads, { recursive: true });
		const archiveName = `${model.archiveName}.${Date.now()}.part`;
		const archive = join(downloads, archiveName);
		const extractRoot = `${this.modelDir(model)}.extract`;
		const extracted = join(extractRoot, model.extractedDirectory);
		await rmAsync(archive, { force: true });
		await rmAsync(extractRoot, { recursive: true, force: true });
		try {
			await this.downloadFile(
				model.archiveUrl,
				archive,
				model.archiveSha256,
				model.archiveMaxBytes,
				model.id,
				"model",
				abort,
			);
			validateTtsArchiveEntries(
				await tarOutput(["-tjf", archiveName], downloads),
				model.extractedDirectory,
			);
			await mkdirAsync(extractRoot, { recursive: true });
			await tarOutput(
				ttsArchiveExtractionArgs(extractRoot, archive, "bzip2"),
				extractRoot,
			);
			await writeFileAsync(
				join(extracted, ".hash"),
				model.archiveSha256,
				"utf8",
			);
			if (
				!installedDirectory(extracted, model.archiveSha256, model.requiredFiles)
			)
				throw new Error("TTS model archive is missing reviewed files");
			replaceRuntimeDirectory(extracted, this.modelDir(model));
		} finally {
			await rmAsync(archive, { force: true });
			await rmAsync(extractRoot, { recursive: true, force: true });
		}
	}

	async download(model: string): Promise<void> {
		const definition = getTtsModelDefinition(model);
		if (!definition) throw new Error("unknown TTS model");
		if (this.downloadAbort) throw new Error("another TTS download is active");
		const abort = new AbortController();
		this.downloadAbort = abort;
		try {
			await this.installRuntime(abort, model);
			if (abort.signal.aborted)
				throw new DOMException("TTS download cancelled", "AbortError");
			await this.installModel(definition, abort);
			if (
				this.config.read_aloud_provider === "neural" &&
				this.config.tts_model === model
			) {
				await this.load(model);
			} else {
				this.statusValue = {
					state:
						this.config.read_aloud_provider === "neural"
							? "unconfigured"
							: "disabled",
					model: this.config.tts_model,
				};
			}
		} catch (error) {
			this.statusValue = {
				...this.statusValue,
				error: error instanceof Error ? error.message : String(error),
			};
			throw error;
		} finally {
			this.downloadAbort = null;
			delete this.statusValue.download;
		}
	}

	cancelDownload(): void {
		this.downloadAbort?.abort();
	}

	async deleteModel(model: string): Promise<void> {
		const definition = getTtsModelDefinition(model);
		if (!definition) throw new Error("unknown TTS model");
		if (this.runtime?.model === model)
			throw new Error("cannot delete the loaded TTS model");
		await rmAsync(this.modelDir(definition), { recursive: true, force: true });
	}

	private voice(id: string): TtsVoiceInfo {
		const definition = getTtsModelDefinition(
			this.runtime?.model ?? this.config.tts_model,
		);
		const voice =
			definition?.voices.find((candidate) => candidate.id === id) ??
			definition?.voices[0];
		if (!voice) throw new Error("TTS voice catalog is empty");
		return voice;
	}

	private async synthesizeOnce(
		text: string,
		voiceId: string,
		speed: number,
	): Promise<TtsSynthesisResult> {
		const runtime = this.runtime;
		if (!runtime || this.statusValue.state !== "ready")
			throw new Error("local neural voice is not ready");
		const response = await this.fetcher(
			`http://127.0.0.1:${runtime.port}/synthesize`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${runtime.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					text,
					speaker: this.voice(voiceId).speaker,
					speed,
				}),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) {
			const detail = (await response.json().catch(() => null)) as {
				error?: string;
			} | null;
			throw new Error(
				detail?.error ?? `local neural synthesis failed (${response.status})`,
			);
		}
		return {
			audio: new Uint8Array(await response.arrayBuffer()),
			synthesisMs:
				Number(response.headers.get("x-hlid-synthesis-ms")) || undefined,
			durationMs:
				Number(response.headers.get("x-hlid-audio-duration-ms")) || undefined,
		};
	}

	async synthesize(
		text: string,
		voiceId: string,
		speed: number,
	): Promise<TtsSynthesisResult> {
		if (!text.trim() || text.length > 300)
			throw new Error("invalid local neural synthesis text");
		if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
			throw new Error("invalid local neural synthesis speed");
		if (this.pendingSynthesis >= 2)
			throw new Error("local neural synthesis queue is full");
		this.pendingSynthesis++;
		const run = async () => {
			try {
				return await this.synthesizeOnce(text, voiceId, speed);
			} catch (error) {
				if (!this.runtime || this.runtime.process.exitCode === null)
					throw error;
				await this.load(this.config.tts_model);
				return this.synthesizeOnce(text, voiceId, speed);
			}
		};
		const result = this.synthesis.then(run, run);
		this.synthesis = result.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await result;
		} finally {
			this.pendingSynthesis--;
		}
	}

	close(): void {
		this.downloadAbort?.abort();
		this.closeRuntime();
	}
}
