import { createRequire } from "node:module";
import { resolve } from "node:path";
import { getTtsModelDefinition } from "./ttsModels";

export const INTERNAL_TTS_RUNTIME_FLAG = "--internal-tts-runtime";
export const MAX_TTS_RUNTIME_TEXT_CHARS = 300;
// Retain enough model-authored silence for commas and list boundaries to sound
// distinct without restoring the unusually long pauses some voices generate.
const LOCAL_NEURAL_SILENCE_SCALE = 0.75;

type GeneratedAudio = {
	samples: Float32Array;
	sampleRate: number;
};

type TtsAddon = {
	version: string;
	createOfflineTts(config: unknown): unknown;
	getOfflineTtsNumSpeakers(handle: unknown): number;
	getOfflineTtsSampleRate(handle: unknown): number;
	offlineTtsGenerateWithConfig(
		handle: unknown,
		request: unknown,
	): GeneratedAudio;
};

export type TtsRuntimeOptions = {
	port: number;
	token: string;
	addonPath: string;
	modelDir: string;
	modelId: string;
	threads: number;
};

function option(args: readonly string[], name: string): string {
	const index = args.indexOf(name);
	if (index < 0 || index + 1 >= args.length) throw new Error(`missing ${name}`);
	return args[index + 1] ?? "";
}

export function parseTtsRuntimeOptions(
	args: readonly string[],
): TtsRuntimeOptions {
	const port = Number(option(args, "--port"));
	const threads = Number(option(args, "--threads"));
	const token = option(args, "--token");
	const addonPath = resolve(option(args, "--addon"));
	const modelDir = resolve(option(args, "--model-dir"));
	const modelId = option(args, "--model-id");
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535)
		throw new Error("invalid TTS runtime port");
	if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32)
		throw new Error("invalid TTS runtime thread count");
	if (!/^[a-f0-9]{64}$/i.test(token))
		throw new Error("invalid TTS runtime token");
	if (!getTtsModelDefinition(modelId)) throw new Error("unknown TTS model");
	return { port, threads, token, addonPath, modelDir, modelId };
}

export function createOfflineTtsConfig(
	modelId: string,
	modelDir: string,
	threads: number,
): unknown {
	const definition = getTtsModelDefinition(modelId);
	if (!definition) throw new Error("unknown TTS model");
	const model = (name: string) => resolve(modelDir, name);
	const family =
		definition.family === "kitten"
			? {
					kitten: {
						model: model(definition.runtime.model),
						voices: model(definition.runtime.voices ?? ""),
						tokens: model(definition.runtime.tokens),
						dataDir: model(definition.runtime.dataDir),
					},
				}
			: {
					vits: {
						model: model(definition.runtime.model),
						tokens: model(definition.runtime.tokens),
						dataDir: model(definition.runtime.dataDir),
					},
				};
	return {
		model: {
			...family,
			debug: false,
			numThreads: threads,
			provider: "cpu",
		},
		maxNumSentences: 1,
	};
}

export function float32ToPcmWav(
	samples: Float32Array,
	sampleRate: number,
): Uint8Array {
	if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
		throw new Error("invalid TTS sample rate");
	const dataBytes = samples.length * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++)
			view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(
			44 + i * 2,
			sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767),
			true,
		);
	}
	return bytes;
}

function authorized(request: Request, token: string): boolean {
	return request.headers.get("authorization") === `Bearer ${token}`;
}

export function createTtsRuntimeFetchHandler(
	addon: TtsAddon,
	handle: unknown,
	token: string,
	modelId: string,
): (request: Request) => Promise<Response> {
	const speakers = addon.getOfflineTtsNumSpeakers(handle);
	const sampleRate = addon.getOfflineTtsSampleRate(handle);
	return async (request) => {
		if (!authorized(request, token))
			return Response.json({ error: "unauthorized" }, { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === "/status" && request.method === "GET") {
			return Response.json({
				ready: true,
				runtime: "sherpa-onnx",
				version: addon.version,
				model: modelId,
				backend: "cpu",
				speakers,
				sampleRate,
			});
		}
		if (url.pathname !== "/synthesize" || request.method !== "POST")
			return Response.json({ error: "not found" }, { status: 404 });
		let body: { text?: unknown; speaker?: unknown; speed?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ error: "invalid JSON body" }, { status: 400 });
		}
		const text = typeof body.text === "string" ? body.text.trim() : "";
		const speaker = Number(body.speaker);
		const speed = Number(body.speed);
		if (!text || text.length > MAX_TTS_RUNTIME_TEXT_CHARS)
			return Response.json(
				{ error: "invalid synthesis text" },
				{ status: 400 },
			);
		if (!Number.isSafeInteger(speaker) || speaker < 0 || speaker >= speakers)
			return Response.json(
				{ error: "invalid synthesis voice" },
				{ status: 400 },
			);
		if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
			return Response.json(
				{ error: "invalid synthesis speed" },
				{ status: 400 },
			);
		try {
			const started = performance.now();
			const audio = addon.offlineTtsGenerateWithConfig(handle, {
				text,
				enableExternalBuffer: true,
				generationConfig: {
					sid: speaker,
					speed,
					silenceScale: LOCAL_NEURAL_SILENCE_SCALE,
				},
			});
			const wav = float32ToPcmWav(audio.samples, audio.sampleRate);
			const body = new ArrayBuffer(wav.byteLength);
			new Uint8Array(body).set(wav);
			return new Response(body, {
				headers: {
					"cache-control": "private, no-store",
					"content-length": String(wav.byteLength),
					"content-type": "audio/wav",
					"x-hlid-audio-duration-ms": String(
						Math.round((audio.samples.length / audio.sampleRate) * 1000),
					),
					"x-hlid-synthesis-ms": String(
						Math.round(performance.now() - started),
					),
				},
			});
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 503 },
			);
		}
	};
}

function loadTtsAddon(addonPath: string): TtsAddon {
	const require = createRequire(import.meta.url);
	return require(addonPath) as TtsAddon;
}

export async function runTtsRuntimeServer(
	args: readonly string[] = process.argv,
): Promise<void> {
	const options = parseTtsRuntimeOptions(args);
	const addon = loadTtsAddon(options.addonPath);
	const handle = addon.createOfflineTts(
		createOfflineTtsConfig(options.modelId, options.modelDir, options.threads),
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port,
		fetch: createTtsRuntimeFetchHandler(
			addon,
			handle,
			options.token,
			options.modelId,
		),
	});
	const close = () => {
		server.stop(true);
		process.exit(0);
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	await new Promise<void>(() => {});
}
