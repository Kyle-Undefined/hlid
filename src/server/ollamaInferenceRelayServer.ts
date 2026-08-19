import type { Server } from "bun";
import {
	OLLAMA_INFERENCE_CHAT_PATH,
	OLLAMA_INFERENCE_MODELS_PATH,
	type OllamaInferenceRelayHandler,
} from "./ollamaInferenceRelay";

type OllamaInferenceRelayServer = Pick<Server<unknown>, "port" | "stop">;

/**
 * Start the Bun network boundary for the inference relay.
 *
 * Bun normalizes dot segments before exposing Request.url and does not expose
 * the raw HTTP origin-form target to fetch handlers. Its route dispatcher does
 * match the incoming path before that normalization. These two literal route
 * entries are therefore the raw-path admission boundary. The fallback must
 * never pass its normalized Request to the relay handler: a traversal alias
 * could otherwise look identical to an allowed path by then.
 */
export function serveOllamaInferenceRelay(options: {
	hostname: string;
	port: number;
	maxRequestBodySize: number;
	fetch: OllamaInferenceRelayHandler;
}): OllamaInferenceRelayServer {
	return Bun.serve({
		hostname: options.hostname,
		port: options.port,
		maxRequestBodySize: options.maxRequestBodySize,
		routes: {
			[OLLAMA_INFERENCE_MODELS_PATH]: (request) =>
				options.fetch(request, { rawTarget: OLLAMA_INFERENCE_MODELS_PATH }),
			[OLLAMA_INFERENCE_CHAT_PATH]: (request) =>
				options.fetch(request, { rawTarget: OLLAMA_INFERENCE_CHAT_PATH }),
		},
		fetch: () =>
			Response.json(
				{ error: "invalid_request_target" },
				{ status: 400, headers: { "cache-control": "no-store" } },
			),
	});
}
