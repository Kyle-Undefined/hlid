import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HlidConfig } from "../config";
import { createCachedList } from "./providerCatalog";

export type VoiceModelInfo = {
	id: string;
	label: string;
	sizeBytes: number;
	sha1: string;
	multilingual: boolean;
	quantized: boolean;
	recommended?: boolean;
	downloadUrl: string;
	installed: boolean;
};

export type VoiceRuntimeState =
	| "disabled"
	| "unconfigured"
	| "unavailable"
	| "loading"
	| "ready"
	| "error";

export type VoiceStatus = {
	state: VoiceRuntimeState;
	model: string;
	loadedModel?: string;
	error?: string;
	download?: { model: string; received: number; total: number | null };
};

type ModelDef = Omit<VoiceModelInfo, "installed" | "downloadUrl">;

const MIB = 1024 * 1024;
const MODEL_DEFS: ModelDef[] = [
	{
		id: "tiny",
		label: "Tiny",
		sizeBytes: 75 * MIB,
		sha1: "bd577a113a864445d4c299885e0cb97d4ba92b5f",
		multilingual: true,
		quantized: false,
	},
	{
		id: "tiny.en",
		label: "Tiny (English)",
		sizeBytes: 75 * MIB,
		sha1: "c78c86eb1a8faa21b369bcd33207cc90d64ae9df",
		multilingual: false,
		quantized: false,
	},
	{
		id: "base",
		label: "Base",
		sizeBytes: 142 * MIB,
		sha1: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
		multilingual: true,
		quantized: false,
		recommended: true,
	},
	{
		id: "base.en",
		label: "Base (English)",
		sizeBytes: 142 * MIB,
		sha1: "137c40403d78fd54d454da0f9bd998f78703390c",
		multilingual: false,
		quantized: false,
	},
	{
		id: "small",
		label: "Small",
		sizeBytes: 466 * MIB,
		sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
		multilingual: true,
		quantized: false,
	},
	{
		id: "small.en",
		label: "Small (English)",
		sizeBytes: 466 * MIB,
		sha1: "db8a495a91d927739e50b3fc1cc4c6b8f6c2d022",
		multilingual: false,
		quantized: false,
	},
	{
		id: "large-v3-turbo-q5_0",
		label: "Large v3 Turbo (Q5)",
		sizeBytes: 547 * MIB,
		sha1: "e050f7970618a659205450ad97eb95a18d69c9ee",
		multilingual: true,
		quantized: true,
	},
];

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export async function validateVoiceRecording(
	audio: Blob,
	maxRecordingSeconds: number,
): Promise<void> {
	if (audio.size > 100 * MIB) throw new Error("audio exceeds 100 MiB limit");
	const header = new DataView(await audio.slice(0, 44).arrayBuffer());
	if (
		header.byteLength < 44 ||
		header.getUint32(0, false) !== 0x52494646 ||
		header.getUint32(8, false) !== 0x57415645
	) {
		throw new Error("audio must be a WAV recording");
	}
	const bytesPerSecond = header.getUint32(28, true);
	if (!bytesPerSecond) throw new Error("invalid WAV byte rate");
	const durationSeconds = Math.max(0, audio.size - 44) / bytesPerSecond;
	if (durationSeconds > maxRecordingSeconds + 1) {
		throw new Error(`recording exceeds ${maxRecordingSeconds} second limit`);
	}
}

function voiceDataDir(): string {
	if (process.platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
			"hlid",
			"voice",
		);
	}
	return join(
		process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
		"hlid",
		"voice",
	);
}

function modelDefinition(id: string): ModelDef {
	const def = MODEL_DEFS.find((candidate) => candidate.id === id);
	if (!def) throw new Error("unknown voice model");
	return def;
}

function modelPath(id: string): string {
	modelDefinition(id);
	const modelsDir = resolve(voiceDataDir(), "models");
	const candidate = resolve(modelsDir, `ggml-${id}.bin`);
	const rel = relative(modelsDir, candidate);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("voice model path escaped models directory");
	}
	return candidate;
}

function canonicalInstalledModelPath(id: string): string {
	const candidate = modelPath(id);
	const root = realpathSync(resolve(voiceDataDir(), "models"));
	const canonical = realpathSync(candidate);
	const rel = relative(root, canonical);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("voice model path escaped models directory");
	}
	return canonical;
}

function catalogValues(): VoiceModelInfo[] {
	return MODEL_DEFS.map((m) => ({
		...m,
		downloadUrl: `${HF_BASE}/ggml-${m.id}.bin`,
		installed: existsSync(modelPath(m.id)),
	}));
}

const catalog = createCachedList<VoiceModelInfo[]>({
	persistKey: "voice_model_catalog",
	// Treat the official repository as the live availability source while keeping
	// sizes and checksums pinned in Hlid's reviewed manifest.
	fetcher: async () => {
		const response = await fetch(`${HF_BASE}/README.md`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) throw new Error(`catalog http ${response.status}`);
		return catalogValues();
	},
	fallback: catalogValues(),
	validate: (v): v is VoiceModelInfo[] => Array.isArray(v),
});

type Runtime = {
	process: ReturnType<typeof Bun.spawn>;
	port: number;
	model: string;
};

type LoadingRuntime = Runtime & {
	abort: AbortController;
	generation: number;
};

export class VoiceModelManager {
	private config: HlidConfig["voice"];
	private runtime: Runtime | null = null;
	private loadingRuntime: LoadingRuntime | null = null;
	private loadGeneration = 0;
	private statusValue: VoiceStatus;
	private downloadAbort: AbortController | null = null;
	private transcription: Promise<unknown> = Promise.resolve();
	private pendingTranscriptions = 0;

	constructor(
		config: HlidConfig["voice"],
		private readonly runtimeExecutable: string | null = null,
	) {
		this.config = config;
		this.statusValue = {
			state: config.enabled ? "unconfigured" : "disabled",
			model: config.model,
		};
	}

	warmCatalog(): void {
		void catalog.get().catch(() => {});
	}

	status(): VoiceStatus {
		return { ...this.statusValue };
	}

	async models(refresh = false): Promise<VoiceModelInfo[]> {
		const { value } = await catalog.get(refresh);
		return value.map((m) => ({ ...m, installed: existsSync(modelPath(m.id)) }));
	}

	async initialize(): Promise<void> {
		if (!this.config.enabled) return;
		if (
			!this.config.model ||
			!MODEL_DEFS.some((model) => model.id === this.config.model) ||
			!existsSync(modelPath(this.config.model))
		) {
			this.statusValue = { state: "unconfigured", model: this.config.model };
			return;
		}
		await this.load(this.config.model);
	}

	async syncConfig(config: HlidConfig["voice"]): Promise<void> {
		const prior = this.config;
		this.config = config;
		if (!config.enabled) {
			this.close();
			this.statusValue = { state: "disabled", model: config.model };
			return;
		}
		if (
			!config.model ||
			!MODEL_DEFS.some((model) => model.id === config.model) ||
			!existsSync(modelPath(config.model))
		) {
			this.cancelLoading();
			this.statusValue = { state: "unconfigured", model: config.model };
			return;
		}
		if (!this.runtime || prior.model !== config.model)
			await this.load(config.model);
	}

	private executable(): string | null {
		if (this.runtimeExecutable && existsSync(this.runtimeExecutable))
			return this.runtimeExecutable;
		const configured = process.env.HLID_WHISPER_SERVER;
		if (configured && existsSync(configured)) return configured;
		const besideExe = join(
			process.execPath.endsWith(".exe")
				? dirname(process.execPath)
				: process.cwd(),
			"whisper-server.exe",
		);
		return existsSync(besideExe) ? besideExe : null;
	}

	private cancelLoading(): void {
		this.loadGeneration++;
		this.loadingRuntime?.abort.abort();
		this.loadingRuntime?.process.kill();
		this.loadingRuntime = null;
	}

	private beginLoad(): number {
		this.cancelLoading();
		return this.loadGeneration;
	}

	private isCurrentLoad(generation: number): boolean {
		return this.loadingRuntime?.generation === generation;
	}

	async load(model: string): Promise<void> {
		modelDefinition(model);
		const generation = this.beginLoad();
		const executable = this.executable();
		if (!executable) {
			this.statusValue = {
				state: "unavailable",
				model,
				error: "whisper runtime is not installed",
			};
			return;
		}
		let installedModel: string;
		try {
			installedModel = canonicalInstalledModelPath(model);
		} catch (error) {
			this.statusValue = {
				state: "error",
				model,
				loadedModel: this.runtime?.model,
				error: (error as Error).message,
			};
			return;
		}
		this.statusValue = {
			state: "loading",
			model,
			loadedModel: this.runtime?.model,
		};
		const port = 18000 + Math.floor(Math.random() * 4000);
		const runtimeDir = dirname(executable);
		const tempDir = join(voiceDataDir(), "tmp");
		mkdirSync(tempDir, { recursive: true });
		const proc = Bun.spawn(
			[
				executable,
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--model",
				installedModel,
				"--convert",
				"--tmp-dir",
				tempDir,
			],
			{
				cwd: runtimeDir,
				stdout: "ignore",
				// Never leave a native child pipe unread: once its OS buffer fills,
				// whisper-server blocks and the browser waits forever.
				stderr: "ignore",
				windowsHide: true,
			},
		);
		const abort = new AbortController();
		this.loadingRuntime = { process: proc, port, model, abort, generation };
		try {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (!this.isCurrentLoad(generation)) {
					proc.kill();
					return;
				}
				if (proc.exitCode !== null)
					throw new Error(`runtime exited with code ${proc.exitCode}`);
				try {
					const res = await fetch(`http://127.0.0.1:${port}/`, {
						signal: AbortSignal.any([abort.signal, AbortSignal.timeout(500)]),
					});
					if (!this.isCurrentLoad(generation)) {
						proc.kill();
						return;
					}
					if (res.ok) break;
				} catch {}
				if (!this.isCurrentLoad(generation)) {
					proc.kill();
					return;
				}
				await Bun.sleep(200);
			}
			if (Date.now() >= deadline) throw new Error("model load timed out");
			if (!this.isCurrentLoad(generation)) {
				proc.kill();
				return;
			}
			const old = this.runtime;
			this.runtime = { process: proc, port, model };
			old?.process.kill();
			this.statusValue = { state: "ready", model, loadedModel: model };
		} catch (error) {
			proc.kill();
			if (!this.isCurrentLoad(generation)) return;
			this.statusValue = {
				state: this.runtime ? "ready" : "error",
				model,
				loadedModel: this.runtime?.model,
				error: (error as Error).message,
			};
		} finally {
			if (this.isCurrentLoad(generation)) this.loadingRuntime = null;
		}
	}

	async download(model: string): Promise<void> {
		const def = modelDefinition(model);
		if (this.downloadAbort) throw new Error("another model download is active");
		mkdirSync(join(voiceDataDir(), "models"), { recursive: true });
		const dest = modelPath(model);
		const temp = `${dest}.part`;
		rmSync(temp, { force: true });
		const abort = new AbortController();
		this.downloadAbort = abort;
		try {
			const response = await fetch(`${HF_BASE}/ggml-${model}.bin`, {
				signal: abort.signal,
			});
			if (!response.ok || !response.body)
				throw new Error(`download http ${response.status}`);
			const total = Number(response.headers.get("content-length")) || null;
			const hash = createHash("sha1");
			let received = 0;
			const progress = new Transform({
				transform: (chunk: Buffer, _encoding, callback) => {
					received += chunk.byteLength;
					hash.update(chunk);
					this.statusValue.download = { model, received, total };
					callback(null, chunk);
				},
			});
			await pipeline(
				Readable.fromWeb(response.body as never),
				progress,
				createWriteStream(temp),
			);
			if (hash.digest("hex") !== def.sha1)
				throw new Error("model checksum mismatch");
			renameSync(temp, dest);
			this.statusValue = { ...this.statusValue, error: undefined };
		} catch (error) {
			this.statusValue = {
				...this.statusValue,
				error: (error as Error).message,
			};
			throw error;
		} finally {
			rmSync(temp, { force: true });
			this.downloadAbort = null;
			delete this.statusValue.download;
		}
	}

	cancelDownload(): void {
		this.downloadAbort?.abort();
	}

	deleteModel(model: string): void {
		modelDefinition(model);
		if (this.runtime?.model === model)
			throw new Error("cannot delete the loaded model");
		const candidate = modelPath(model);
		if (!existsSync(candidate)) return;
		rmSync(canonicalInstalledModelPath(model), { force: true });
	}

	async transcribe(
		audio: Blob,
		language: string,
	): Promise<{ text: string; language?: string; durationMs: number }> {
		if (!this.runtime || this.statusValue.state !== "ready")
			throw new Error("voice model is not ready");
		if (this.pendingTranscriptions >= 2)
			throw new Error("voice transcription queue is full");
		await validateVoiceRecording(audio, this.config.max_recording_seconds);
		const run = async () => {
			const started = performance.now();
			const form = new FormData();
			form.set("file", audio, "recording.wav");
			form.set("response_format", "json");
			if (language !== "auto") form.set("language", language);
			const response = await fetch(
				`http://127.0.0.1:${this.runtime?.port}/inference`,
				{
					method: "POST",
					body: form,
					signal: AbortSignal.timeout(60_000),
				},
			);
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(
					`transcription failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
				);
			}
			const result = (await response.json()) as {
				text?: string;
				language?: string;
			};
			return {
				text: result.text?.trim() ?? "",
				language: result.language,
				durationMs: Math.round(performance.now() - started),
			};
		};
		this.pendingTranscriptions++;
		const result = this.transcription.then(run, run);
		this.transcription = result.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await result;
		} finally {
			this.pendingTranscriptions--;
		}
	}

	close(): void {
		this.downloadAbort?.abort();
		this.cancelLoading();
		this.runtime?.process.kill();
		this.runtime = null;
	}
}
