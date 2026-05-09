/**
 * AcpProvider — contract spec for the future ACP (Agent Client Protocol) provider.
 *
 * All tests are skipped. They exist to define the expected behavior of AcpProvider
 * before implementation begins; green them one by one as AcpProvider is built.
 *
 * ACP reference: https://agentclientprotocol.modelcontextprotocol.io/
 * SDK: @agentclientprotocol/sdk
 */
import { describe, it } from "vitest";

// Future import — uncomment when implementation begins:
// import { AcpProvider } from "./acpProvider";
// import type { AgentProvider } from "./agentProvider";

// ── Interface compliance ───────────────────────────────────────────────────────

describe("AcpProvider — interface compliance", () => {
	it.todo("implements AgentProvider interface (query returns AgentSession)");

	it.todo("AgentSession is async iterable over AgentEvent");

	it.todo("AgentSession.cancel() stops iteration");
});

// ── Event mapping ──────────────────────────────────────────────────────────────

describe("AcpProvider — event mapping", () => {
	it.todo("yields session_start with ACP session id on connect");

	it.todo("yields text_delta for each streamed text chunk");

	it.todo("yields tool_start when ACP server requests a tool invocation");

	it.todo("yields usage event with token counts from ACP usage report");

	it.todo("yields done with turns and durationMs on run completion");

	it.todo("yields done.stopReason reflecting ACP end_turn or max_turns");
});

// ── Permission / canUseTool ────────────────────────────────────────────────────

describe("AcpProvider — canUseTool", () => {
	it.todo("calls canUseTool for each tool_use request from ACP server");

	it.todo("allow decision forwards tool call to ACP server");

	it.todo("deny decision sends permission_denied response to ACP server");

	// ACP session/request_permission only supports allow/deny — no input mutation.
	// AskUserQuestion answer injection in session.ts uses updatedInput, which ClaudeProvider
	// passes through to the SDK. AcpProvider cannot support this without a session.ts
	// interface change. Design the mechanism (e.g. onAskUser side-channel on AgentQueryParams)
	// when the first concrete ACP agent is chosen — not before, as the right shape
	// depends on that agent's actual protocol for question/answer.
	it.todo(
		"allow decision does NOT mutate input (ACP protocol limitation — design ask-user mechanism when first ACP agent is chosen)",
	);
});

// ── Session lifecycle ──────────────────────────────────────────────────────────

describe("AcpProvider — session lifecycle", () => {
	it.todo("connects to ACP server via stdio transport by default");

	it.todo("connects via HTTP/WebSocket transport when endpoint configured");

	it.todo("persistSession:false creates ephemeral run (no session stored)");

	it.todo("sessionId passed as ACP resume token for multi-turn sessions");

	it.todo("closes transport on cancel()");
});

// ── MCP status ────────────────────────────────────────────────────────────────

describe("AcpProvider — MCP status", () => {
	it.todo(
		"mcpServerStatus() returns empty array when ACP server has no MCP info",
	);

	it.todo("mcpServerStatus() maps ACP server list to McpServerStatus shape");
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("AcpProvider — error handling", () => {
	it.todo("propagates ACP transport errors as thrown exceptions in iteration");

	it.todo("respects AbortSignal and cancels in-flight request");
});
