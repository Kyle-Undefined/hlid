import { describe, expect, it } from "vitest";
import {
	parseClientMessage,
	parseInitialTerminalDimensions,
	parseTerminalResize,
} from "./wsSchemas";

describe("chat WebSocket runtime schema", () => {
	it.each([
		"null",
		"42",
		'"chat"',
		"[]",
		"{}",
	])("rejects non-message JSON %s", (raw) => {
		expect(parseClientMessage(raw)).toBeNull();
	});

	it("rejects unknown fields and unknown message types", () => {
		expect(
			parseClientMessage(JSON.stringify({ type: "sync", extra: true })),
		).toBeNull();
		expect(
			parseClientMessage(JSON.stringify({ type: "root_shell" })),
		).toBeNull();
	});

	it("bounds chat text and attachment arrays", () => {
		expect(
			parseClientMessage(
				JSON.stringify({ type: "chat", text: "x".repeat(1024 * 1024 + 1) }),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "hello",
					attachments: Array.from({ length: 33 }, (_, index) => ({
						id: String(index),
						path: "/tmp/file",
						filename: "file.txt",
						mime: "text/plain",
						kind: "ephemeral",
					})),
				}),
			),
		).toBeNull();
	});

	it("accepts a bounded valid message", () => {
		expect(
			parseClientMessage(JSON.stringify({ type: "chat", text: "hello" })),
		).toEqual({ type: "chat", text: "hello" });
	});

	it("accepts attachment-only chat and rejects a fully empty chat", () => {
		const attachment = {
			id: "attachment-1",
			path: "/tmp/shot.png",
			filename: "shot.png",
			mime: "image/png",
			kind: "ephemeral",
		};
		expect(
			parseClientMessage(
				JSON.stringify({ type: "chat", text: "", attachments: [attachment] }),
			),
		).toEqual({ type: "chat", text: "", attachments: [attachment] });
		expect(
			parseClientMessage(JSON.stringify({ type: "chat", text: "" })),
		).toBeNull();
	});

	it("accepts vault-reference-only chat and bounds the selection", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					vault_references: ["Projects/Hlid.md"],
				}),
			),
		).toEqual({
			type: "chat",
			text: "",
			vault_references: ["Projects/Hlid.md"],
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					vault_references: Array.from(
						{ length: 33 },
						(_, index) => `Note-${index}.md`,
					),
				}),
			),
		).toBeNull();
	});

	it("accepts bounded hashed workspace references and rejects invalid revisions", () => {
		const reference = {
			relativePath: "src/server/session.ts",
			sha256: "a".repeat(64),
		};
		const references = Array.from({ length: 8 }, (_, index) => ({
			...reference,
			relativePath: `src/file-${index}.ts`,
		}));
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					workspace_references: references,
				}),
			),
		).toEqual({
			type: "chat",
			text: "",
			workspace_references: references,
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					workspace_references: [
						...references,
						{ ...reference, relativePath: "ninth.ts" },
					],
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					workspace_references: [
						{ relativePath: reference.relativePath, sha256: "not-a-hash" },
					],
				}),
			),
		).toBeNull();
	});

	it("caps mixed Vault, Workspace, and Relic references per turn", () => {
		const workspaceReferences = Array.from({ length: 8 }, (_, index) => ({
			relativePath: `src/file-${index}.ts`,
			sha256: "a".repeat(64),
		}));
		const relic = {
			id: "relic-1",
			path: "/tmp/report.pdf",
			filename: "report.pdf",
			mime: "application/pdf",
			kind: "retained",
			reference: "relic",
		};
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					vault_references: Array.from(
						{ length: 23 },
						(_, index) => `Note-${index}.md`,
					),
					workspace_references: workspaceReferences,
					attachments: [relic],
				}),
			),
		).not.toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "",
					vault_references: Array.from(
						{ length: 24 },
						(_, index) => `Note-${index}.md`,
					),
					workspace_references: workspaceReferences,
					attachments: [relic],
				}),
			),
		).toBeNull();
	});

	it("accepts the computer-use capability action", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "/computer-use open Calculator",
					command_action: "computer-use",
				}),
			),
		).toEqual({
			type: "chat",
			text: "/computer-use open Calculator",
			command_action: "computer-use",
		});
	});

	it("accepts skip_sleep and rejects extra fields on it", () => {
		expect(parseClientMessage(JSON.stringify({ type: "skip_sleep" }))).toEqual({
			type: "skip_sleep",
		});
		expect(
			parseClientMessage(JSON.stringify({ type: "skip_sleep", extra: 1 })),
		).toBeNull();
	});

	it("accepts only bounded text-only active steering", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "steer_active",
					session_id: "child-session",
					turn_id: "steer-1",
					text: "Check the failing branch",
				}),
			),
		).toEqual({
			type: "steer_active",
			session_id: "child-session",
			turn_id: "steer-1",
			text: "Check the failing branch",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "steer_active",
					session_id: "child-session",
					turn_id: "steer-1",
					text: " ",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "steer_active",
					session_id: "child-session",
					turn_id: "steer-1",
					text: "Check the failing branch",
					attachments: [],
				}),
			),
		).toBeNull();
	});

	it("accepts only bounded native workflow stop controls", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "workflow_control",
					action: "stop",
					task_id: "workflow-task-1",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "workflow_control",
			action: "stop",
			task_id: "workflow-task-1",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "workflow_control",
					action: "resume",
					task_id: "workflow-task-1",
				}),
			),
		).toBeNull();
	});

	it("validates workflow discovery and save requests", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "probe_workflows",
					agent_cwd: "/tmp/project",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "probe_workflows",
			agent_cwd: "/tmp/project",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "save_workflow",
					request_id: "request-1",
					session_id: "session-1",
					source_script_path:
						"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
					scope: "project",
					overwrite: true,
				}),
			),
		).toEqual({
			type: "save_workflow",
			request_id: "request-1",
			session_id: "session-1",
			source_script_path:
				"/tmp/.claude/projects/project/session/workflows/scripts/audit.js",
			scope: "project",
			overwrite: true,
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "save_workflow",
					request_id: "request-1",
					source_script_path: "/tmp/audit.js",
					scope: "workspace",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "delete_workflow",
					request_id: "request-2",
					session_id: "session-1",
					script_path: "/tmp/project/.claude/workflows/audit.js",
					scope: "project",
				}),
			),
		).toEqual({
			type: "delete_workflow",
			request_id: "request-2",
			session_id: "session-1",
			script_path: "/tmp/project/.claude/workflows/audit.js",
			scope: "project",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "delete_workflow",
					request_id: "request-2",
					script_path: "/tmp/project/.claude/workflows/audit.js",
					scope: "workspace",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "read_workflow_source",
					request_id: "request-3",
					session_id: "session-1",
					script_path: "/tmp/project/.claude/workflows/audit.js",
					scope: "project",
				}),
			),
		).toEqual({
			type: "read_workflow_source",
			request_id: "request-3",
			session_id: "session-1",
			script_path: "/tmp/project/.claude/workflows/audit.js",
			scope: "project",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "read_workflow_source",
					request_id: "request-3",
					script_path: "/tmp/generated-audit.js",
				}),
			),
		).toEqual({
			type: "read_workflow_source",
			request_id: "request-3",
			script_path: "/tmp/generated-audit.js",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "read_workflow_source",
					request_id: "request-3",
					script_path: "/tmp/generated-audit.js",
					scope: "workspace",
				}),
			),
		).toBeNull();
	});

	it("validates native goal controls", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "goal_control",
					request_id: "request-1",
					session_id: "session-1",
					action: "set",
					objective: "Finish the release gate",
					token_budget: 50_000,
				}),
			),
		).toMatchObject({ action: "set", token_budget: 50_000 });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "goal_control",
					request_id: "request-1",
					session_id: "session-1",
					action: "set",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "goal_control",
					request_id: "request-1",
					session_id: "session-1",
					action: "pause",
					token_budget: 50_000,
				}),
			),
		).toBeNull();
	});

	it("validates Codex realtime voice controls", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_start",
					session_id: "session-1",
					mode: "live",
					sdp: "v=0\r\n",
					voice: "marin",
				}),
			),
		).toMatchObject({ type: "realtime_start", mode: "live", voice: "marin" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_speak",
					session_id: "session-1",
					text: "Read this response",
				}),
			),
		).toMatchObject({ type: "realtime_speak" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_start",
					session_id: "session-1",
					mode: "unknown",
					sdp: "v=0\r\n",
				}),
			),
		).toBeNull();
	});

	it("validates a goal attached to its starting chat turn", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "Finish the release gate",
					goal: {
						objective: "Finish the release gate",
						token_budget: 50_000,
					},
				}),
			),
		).toMatchObject({
			type: "chat",
			goal: { objective: "Finish the release gate", token_budget: 50_000 },
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "Finish the release gate",
					goal: { objective: "" },
				}),
			),
		).toBeNull();
	});

	it("accepts plan_mode and plan_html flags", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "hello",
					plan_mode: true,
					plan_html: true,
				}),
			),
		).toEqual({
			type: "chat",
			text: "hello",
			plan_mode: true,
			plan_html: true,
		});
	});
});

describe("terminal WebSocket runtime schema", () => {
	it("rejects primitives, unknown controls, and non-numeric dimensions", () => {
		expect(parseTerminalResize("null")).toBeNull();
		expect(parseTerminalResize(JSON.stringify({ type: "write" }))).toBeNull();
		expect(
			parseTerminalResize(
				JSON.stringify({ type: "resize", cols: "80", rows: 24 }),
			),
		).toBeNull();
	});

	it("clamps resize and initial dimensions", () => {
		expect(
			parseTerminalResize(
				JSON.stringify({ type: "resize", cols: 999_999, rows: -5 }),
			),
		).toEqual({ cols: 500, rows: 1 });
		expect(parseInitialTerminalDimensions("NaN", "Infinity")).toEqual({
			cols: 80,
			rows: 24,
		});
	});
});
