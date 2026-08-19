import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOllamaInferenceRelay,
	OLLAMA_INFERENCE_MAX_REQUEST_BYTES,
	OllamaInferenceLeaseRegistry,
} from "./ollamaInferenceRelay";
import { serveOllamaInferenceRelay } from "./ollamaInferenceRelayServer";

const NOW = 1_700_000_000_000;
const TOKEN = "a".repeat(43);
const MODEL = "qwen3-coder:30b";

function rawHttpRequest(input: {
	port: number;
	method?: "GET" | "POST";
	target: string;
	token?: string;
	body?: string;
}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port: input.port });
		let response = "";
		const body = input.body ?? "";
		socket.setTimeout(5_000, () => {
			socket.destroy(new Error("Raw Ollama relay request timed out"));
		});
		socket.once("connect", () => {
			const headers = [
				`${input.method ?? "GET"} ${input.target} HTTP/1.1`,
				`Host: 127.0.0.1:${input.port}`,
				"Connection: close",
				...(input.token ? [`Authorization: Bearer ${input.token}`] : []),
				...(body
					? [
							"Content-Type: application/json",
							`Content-Length: ${Buffer.byteLength(body)}`,
						]
					: []),
				"",
				body,
			];
			socket.write(headers.join("\r\n"));
		});
		socket.on("data", (chunk) => {
			response += chunk.toString("utf8");
		});
		socket.once("error", reject);
		socket.once("end", () => {
			const [head = "", responseBody = ""] = response.split("\r\n\r\n", 2);
			const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]);
			resolve({ status, body: responseBody });
		});
	});
}

const servers: Array<ReturnType<typeof serveOllamaInferenceRelay>> = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe("Ollama inference relay Bun network admission", () => {
	it("rejects raw encoded and dot traversal aliases before normalized routing", async () => {
		const leases = new OllamaInferenceLeaseRegistry({
			now: () => NOW,
			tokenFactory: () => TOKEN,
			idFactory: () => "lease-1",
		});
		const lease = leases.issue({
			profileId: "acp:opencode",
			targetId: "wsl:Ubuntu-24.04",
			processId: "opencode:test",
			allowedModels: [MODEL],
			expiresAt: NOW + 60_000,
		});
		const upstreamFetch = vi.fn(async () =>
			Response.json({ data: [{ id: MODEL, object: "model" }] }),
		);
		const relay = createOllamaInferenceRelay({ leases, upstreamFetch });
		const server = serveOllamaInferenceRelay({
			hostname: "127.0.0.1",
			port: 0,
			maxRequestBodySize: OLLAMA_INFERENCE_MAX_REQUEST_BYTES,
			fetch: relay,
		});
		servers.push(server);
		const port = server.port;
		if (typeof port !== "number") {
			throw new Error("Bun did not assign the Ollama relay test port");
		}

		const encodedModelsAlias = await rawHttpRequest({
			port,
			target: "/prefix/%2e%2e/v1/models",
			token: lease.token,
		});
		const dotChatAlias = await rawHttpRequest({
			port,
			method: "POST",
			target: "/v1/private/../chat/completions",
			token: lease.token,
			body: JSON.stringify({ model: MODEL, messages: [] }),
		});

		expect(encodedModelsAlias.status).toBe(400);
		expect(JSON.parse(encodedModelsAlias.body)).toEqual({
			error: "invalid_request_target",
		});
		expect(dotChatAlias.status).toBe(400);
		expect(JSON.parse(dotChatAlias.body)).toEqual({
			error: "invalid_request_target",
		});
		expect(upstreamFetch).not.toHaveBeenCalled();

		const exactUnauthenticated = await rawHttpRequest({
			port,
			target: "/v1/models",
		});
		expect(exactUnauthenticated.status).toBe(401);
		expect(upstreamFetch).not.toHaveBeenCalled();

		const exactAuthenticated = await rawHttpRequest({
			port,
			target: "/v1/models",
			token: lease.token,
		});
		expect(exactAuthenticated.status).toBe(200);
		expect(upstreamFetch).toHaveBeenCalledOnce();
	});
});
