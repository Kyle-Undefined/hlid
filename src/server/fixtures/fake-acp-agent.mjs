#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const sessions = new Map();
const configOptions = (session) => [
	{
		type: "select",
		id: "model",
		name: "Model",
		category: "model",
		currentValue: session?.model ?? "fake-fast",
		options: [
			{ value: "fake-fast", name: "Fake Fast" },
			{ value: "fake-smart", name: "Fake Smart" },
		],
	},
	{
		type: "select",
		id: "thought",
		name: "Reasoning",
		category: "thought_level",
		currentValue: session?.effort ?? "medium",
		options: [
			{ value: "low", name: "Low" },
			{ value: "medium", name: "Medium" },
			{ value: "high", name: "High" },
		],
	},
];
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
	.onRequest("session/new", ({ params }) => {
		const sessionId = "fake-session";
		const session = {
			cancelled: false,
			mode: "code",
			model: "fake-fast",
			effort: "medium",
			mcpCount: params.mcpServers.length,
		};
		sessions.set(sessionId, session);
		return {
			sessionId,
			modes: {
				currentModeId: "code",
				availableModes: [
					{ id: "code", name: "Code" },
					{ id: "plan", name: "Plan" },
				],
			},
			configOptions: configOptions(session),
		};
	})
	.onRequest("session/load", ({ params }) => {
		const session = {
			cancelled: false,
			mode: "code",
			model: "fake-fast",
			effort: "medium",
			mcpCount: params.mcpServers.length,
		};
		sessions.set(params.sessionId, session);
		return {
			modes: {
				currentModeId: session.mode,
				availableModes: [
					{ id: "code", name: "Code" },
					{ id: "plan", name: "Plan" },
				],
			},
			configOptions: configOptions(session),
		};
	})
	.onRequest("session/set_mode", ({ params }) => {
		const session = sessions.get(params.sessionId);
		if (session) session.mode = params.modeId;
		return {};
	})
	.onRequest("session/set_config_option", ({ params }) => {
		const session = sessions.get(params.sessionId);
		if (session && params.configId === "model") session.model = params.value;
		if (session && params.configId === "thought") session.effort = params.value;
		return { configOptions: configOptions(session) };
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
		if (text === "report-mode") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: sessions.get(params.sessionId)?.mode ?? "unknown",
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "report-config") {
			const session = sessions.get(params.sessionId);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `${session?.model}/${session?.effort}`,
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "report-mcp") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: String(sessions.get(params.sessionId)?.mcpCount ?? 0),
					},
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "elicit") {
			const response = await client.request(methods.client.elicitation.create, {
				mode: "form",
				sessionId: params.sessionId,
				message: "Choose deployment settings",
				requestedSchema: {
					type: "object",
					properties: {
						environment: {
							type: "string",
							title: "Environment",
							enum: ["staging", "production"],
						},
						replicas: {
							type: "integer",
							title: "Replicas",
						},
					},
					required: ["environment", "replicas"],
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: JSON.stringify(response) },
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "plan-update") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "plan",
					entries: [
						{ content: "Research", priority: "high", status: "in_progress" },
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "plan-remove") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "plan_update",
					plan: { type: "markdown", id: "draft", content: "# Draft" },
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: { sessionUpdate: "plan_removed", id: "draft" },
			});
			return { stopReason: "end_turn" };
		}
		if (text === "usage-update") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: 1234,
					size: 8192,
					cost: { amount: 0.25, currency: "USD" },
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "structured-tool") {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "structured-1",
					title: "Edit a file",
					kind: "edit",
					status: "completed",
					rawInput: { path: "a.txt" },
					content: [
						{
							type: "diff",
							path: "a.txt",
							oldText: "old",
							newText: "new",
						},
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "obsidian-long-result") {
			const path = "Projects/Hlid.md";
			const content = "x".repeat(2_000);
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "obsidian-long-1",
					title: "hlid_obsidian.append_note",
					kind: "other",
					status: "pending",
					rawInput: { target: "path", path, content },
				},
			});
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "obsidian-long-1",
					status: "completed",
					rawOutput: {
						arguments: { target: "path", path, content },
						result: { path },
					},
					content: [
						{
							type: "content",
							content: {
								type: "text",
								text: JSON.stringify({ path }),
							},
						},
					],
				},
			});
			return { stopReason: "end_turn" };
		}
		if (text === "tool-kind-matrix") {
			const tools = [
				["read", "Read file"],
				["edit", "Edit file"],
				["delete", "Delete file"],
				["move", "Move file"],
				["search", "Search files"],
				["execute", "Run command"],
				["think", "Think"],
				["fetch", "Fetch URL"],
				["switch_mode", "Planning mode"],
				["other", "Custom action"],
			];
			for (const [index, [kind, title]] of tools.entries()) {
				const toolCall = {
					toolCallId: `kind-${index}`,
					title,
					kind,
					rawInput: { kind },
				};
				await client.notify(methods.client.session.update, {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call",
						...toolCall,
						status: "pending",
					},
				});
				await client.request(methods.client.session.requestPermission, {
					sessionId: params.sessionId,
					toolCall,
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "deny", name: "Deny", kind: "reject_once" },
					],
				});
			}
			return { stopReason: "end_turn" };
		}
		if (text.startsWith("The user approved the plan.")) {
			await client.notify(methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "implemented" },
				},
			});
			return { stopReason: "end_turn" };
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
		const obsidianCommand = text === "obsidian-command";
		const tool = {
			toolCallId: "tool-1",
			title: obsidianCommand
				? "Obsidian run command"
				: text === "read-permission"
					? "Read file"
					: "Write file",
			kind: obsidianCommand
				? "other"
				: text === "read-permission"
					? "read"
					: "edit",
			rawInput: obsidianCommand
				? { id: "app:toggle-left-sidebar" }
				: {
						path:
							text === "html-plan"
								? "/vault/.hlid/plans/plan-fake.html"
								: "a.txt",
					},
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
