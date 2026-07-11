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

agent({ name: "hlid-fake-agent" })
	.onRequest("initialize", () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: { loadSession: true },
		authMethods: [{ id: "fake-login", name: "Fake login" }],
		agentInfo: { name: "fake-acp", version: "1.0.0" },
	}))
	.onRequest("authenticate", () => ({}))
	.onRequest("session/new", () => {
		const sessionId = "fake-session";
		sessions.set(sessionId, { cancelled: false });
		return { sessionId };
	})
	.onRequest("session/load", ({ params }) => {
		sessions.set(params.sessionId, { cancelled: false });
		return {};
	})
	.onNotification("session/cancel", ({ params }) => {
		const session = sessions.get(params.sessionId);
		if (session) session.cancelled = true;
	})
	.onRequest("session/prompt", async ({ params, client }) => {
		const text =
			params.prompt.find((block) => block.type === "text")?.text ?? "";
		if (text === "transport-error") process.exit(2);
		if (text === "slow") {
			while (!sessions.get(params.sessionId)?.cancelled) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return { stopReason: "cancelled" };
		}
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "help", description: "Show help", input: { hint: "topic" } },
				],
			},
		});
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello " },
			},
		});
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "world" },
			},
		});
		const tool = {
			toolCallId: "tool-1",
			title: "Write file",
			kind: "edit",
			rawInput: { path: "a.txt" },
		};
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: { sessionUpdate: "tool_call", ...tool, status: "pending" },
		});
		const permission = await client.request(
			methods.client.session.requestPermission,
			{
				sessionId: params.sessionId,
				toolCall: tool,
				options: [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			},
		);
		const allowed =
			permission.outcome.outcome === "selected" &&
			permission.outcome.optionId === "allow";
		await client.notify(methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: allowed ? "completed" : "failed",
				rawOutput: allowed ? "allowed" : "permission_denied",
			},
		});
		return {
			stopReason: text === "max" ? "max_turn_requests" : "end_turn",
			usage: {
				totalTokens: 7,
				inputTokens: 4,
				outputTokens: 3,
				cachedReadTokens: 1,
			},
		};
	})
	.connect(stream);
