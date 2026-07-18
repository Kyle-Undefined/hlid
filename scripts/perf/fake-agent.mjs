#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const stream = ndJsonStream(
	Writable.toWeb(process.stdout),
	Readable.toWeb(process.stdin),
);

function configOptions() {
	return [
		{
			type: "select",
			id: "model",
			name: "Model",
			category: "model",
			currentValue: "fake-fast",
			options: [{ value: "fake-fast", name: "Fake Fast" }],
		},
	];
}

function sessionMetadata() {
	return {
		modes: {
			currentModeId: "code",
			availableModes: [{ id: "code", name: "Code" }],
		},
		configOptions: configOptions(),
	};
}

async function sendChunk(client, sessionId, text) {
	await client.notify(methods.client.session.update, {
		sessionId,
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
		},
	});
}

agent({ name: "hlid-performance-agent" })
	.onRequest("initialize", () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: { loadSession: true },
		agentInfo: { name: "hlid-performance-agent", version: "1.0.0" },
	}))
	.onRequest("session/new", () => {
		const sessionId = `perf-${Date.now()}`;
		sessions.set(sessionId, { cancelled: false });
		return { sessionId, ...sessionMetadata() };
	})
	.onRequest("session/load", ({ params }) => {
		sessions.set(params.sessionId, { cancelled: false });
		return sessionMetadata();
	})
	.onRequest("session/set_mode", () => ({}))
	.onRequest("session/set_config_option", () => ({
		configOptions: configOptions(),
	}))
	.onNotification("session/cancel", ({ params }) => {
		const session = sessions.get(params.sessionId);
		if (session) session.cancelled = true;
	})
	.onRequest("session/prompt", async ({ params, client }) => {
		const prompt =
			params.prompt.find((block) => block.type === "text")?.text ?? "";
		if (prompt !== "perf-stream") {
			await sendChunk(client, params.sessionId, `echo: ${prompt}`);
			return { stopReason: "end_turn" };
		}

		await sendChunk(client, params.sessionId, "# Streaming performance gate\n\n");
		for (let index = 0; index < 180; index++) {
			if (sessions.get(params.sessionId)?.cancelled) {
				return { stopReason: "cancelled" };
			}
			await sendChunk(
				client,
				params.sessionId,
				`- streamed Markdown row ${index}: **stable behavior** with \`chunk-${index}\`\n`,
			);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await sendChunk(client, params.sessionId, "\nPERF_STREAM_DONE");
		return { stopReason: "end_turn" };
	})
	.connect(stream);
