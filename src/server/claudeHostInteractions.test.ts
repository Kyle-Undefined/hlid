import { describe, expect, it, vi } from "vitest";
import type { AgentQueryParams } from "./agentProvider";
import {
	CLAUDE_SUPPORTED_DIALOG_KINDS,
	createClaudeHostInteractionHandlers,
} from "./claudeHostInteractions";
import { ASK_USER_QUESTION_CANCEL_KEY } from "./protocol";

function params(canUseTool: AgentQueryParams["canUseTool"]): AgentQueryParams {
	return {
		cwd: "/work",
		hostSessionId: "hlid-session",
		canUseTool,
	};
}

describe("Claude host interactions", () => {
	it("maps structured MCP form answers back to the native elicitation result", async () => {
		const canUseTool = vi.fn(async (_tool, input) => {
			const questions = (input as { questions: Array<{ question: string }> })
				.questions;
			expect(questions).toMatchObject([
				{ question: "Name", freeText: true },
				{ question: "Retries", freeText: true, optional: true },
				{ question: "Enabled", options: ["Yes", "No"] },
				{ question: "Scopes", multiSelect: true, optional: true },
			]);
			return {
				behavior: "allow" as const,
				updatedInput: {
					answers: {
						Name: "Raven",
						Retries: "3",
						Enabled: "No",
						Scopes: "read, write",
					},
				},
			};
		});
		const handlers = createClaudeHostInteractionHandlers(params(canUseTool));
		const result = await handlers.onElicitation(
			{
				serverName: "test-mcp",
				message: "Configure the connection",
				mode: "form",
				displayName: "connect",
				requestedSchema: {
					type: "object",
					required: ["name", "enabled"],
					properties: {
						name: { type: "string", title: "Name" },
						retries: { type: "integer", title: "Retries" },
						enabled: { type: "boolean", title: "Enabled" },
						scopes: {
							type: "array",
							title: "Scopes",
							items: { type: "string", enum: ["read", "write"] },
						},
					},
				},
			},
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({
			action: "accept",
			content: {
				name: "Raven",
				retries: 3,
				enabled: false,
				scopes: ["read", "write"],
			},
		});
		expect(canUseTool).toHaveBeenCalledWith(
			"AskUserQuestion",
			expect.any(Object),
			expect.objectContaining({
				toolUseID: expect.stringContaining("hlid-session"),
				interaction: expect.objectContaining({
					provider_id: "claude",
					kind: "mcp_elicitation",
					source_name: "test-mcp",
					tool_name: "connect",
				}),
			}),
		);
	});

	it("renders URL elicitation through the shared question path", async () => {
		const canUseTool = vi.fn(async (_tool, input) => {
			const question = (
				input as { questions: Array<{ question: string; options: string[] }> }
			).questions[0];
			return {
				behavior: "allow" as const,
				updatedInput: {
					answers: {
						[question.question]: question.options[0],
					},
				},
			};
		});
		const handlers = createClaudeHostInteractionHandlers(params(canUseTool));
		await expect(
			handlers.onElicitation(
				{
					serverName: "oauth-mcp",
					message: "Authenticate the connector",
					mode: "url",
					url: "https://example.test/oauth",
					elicitationId: "oauth-1",
				},
				{ signal: new AbortController().signal },
			),
		).resolves.toEqual({ action: "accept" });
		expect(canUseTool).toHaveBeenCalledWith(
			"AskUserQuestion",
			expect.any(Object),
			expect.objectContaining({
				interaction: expect.objectContaining({
					source_name: "oauth-mcp",
					url: "https://example.test/oauth",
				}),
			}),
		);
	});

	it("maps shared cancellation to native MCP cancel", async () => {
		const handlers = createClaudeHostInteractionHandlers(
			params(
				vi.fn().mockResolvedValue({
					behavior: "allow",
					updatedInput: {
						answers: { [ASK_USER_QUESTION_CANCEL_KEY]: "" },
					},
				}),
			),
		);
		await expect(
			handlers.onElicitation(
				{
					serverName: "test-mcp",
					message: "Need a value",
					mode: "form",
					requestedSchema: {
						type: "object",
						required: ["value"],
						properties: { value: { type: "string" } },
					},
				},
				{ signal: new AbortController().signal },
			),
		).resolves.toEqual({ action: "cancel" });
	});

	it("supports only the documented refusal fallback dialog and preserves its result", async () => {
		const canUseTool = vi.fn(async (_tool, input) => {
			const question = (
				input as { questions: Array<{ question: string; options: string[] }> }
			).questions[0];
			return {
				behavior: "allow" as const,
				updatedInput: {
					answers: { [question.question]: question.options[0] },
				},
			};
		});
		const handlers = createClaudeHostInteractionHandlers(params(canUseTool));

		expect(handlers.supportedDialogKinds).toEqual([
			...CLAUDE_SUPPORTED_DIALOG_KINDS,
		]);
		await expect(
			handlers.onUserDialog(
				{
					dialogKind: "refusal_fallback_prompt",
					payload: { message: "Choose a recovery path" },
					toolUseID: "tool-1",
				},
				{ signal: new AbortController().signal },
			),
		).resolves.toEqual({
			behavior: "completed",
			result: "retry_fallback",
		});
		expect(canUseTool).toHaveBeenCalledWith(
			"AskUserQuestion",
			expect.any(Object),
			expect.objectContaining({
				interaction: expect.objectContaining({
					kind: "provider_dialog",
					source_name: "refusal_fallback_prompt",
					tool_use_id: "tool-1",
				}),
			}),
		);
	});

	it("fails closed for unknown dialog kinds without opening Hlid input", async () => {
		const canUseTool = vi.fn();
		const handlers = createClaudeHostInteractionHandlers(params(canUseTool));
		await expect(
			handlers.onUserDialog(
				{ dialogKind: "future_dialog", payload: {} },
				{ signal: new AbortController().signal },
			),
		).resolves.toEqual({ behavior: "cancelled" });
		expect(canUseTool).not.toHaveBeenCalled();
	});

	it("declines malformed or unsupported MCP schemas", async () => {
		const canUseTool = vi.fn();
		const handlers = createClaudeHostInteractionHandlers(params(canUseTool));
		await expect(
			handlers.onElicitation(
				{
					serverName: "test-mcp",
					message: "Nested input",
					mode: "form",
					requestedSchema: {
						type: "object",
						properties: { nested: { type: "object" } },
					},
				},
				{ signal: new AbortController().signal },
			),
		).resolves.toEqual({ action: "decline" });
		expect(canUseTool).not.toHaveBeenCalled();
	});
});
