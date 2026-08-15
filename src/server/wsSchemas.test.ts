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

	it("accepts only bounded connection probe request ids", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "connection_probe",
					request_id: "resume-1",
				}),
			),
		).toEqual({ type: "connection_probe", request_id: "resume-1" });
		for (const request_id of ["", "x".repeat(257)]) {
			expect(
				parseClientMessage(
					JSON.stringify({ type: "connection_probe", request_id }),
				),
			).toBeNull();
		}
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "connection_probe",
					request_id: "resume-1",
					extra: true,
				}),
			),
		).toBeNull();
	});

	it("accepts only bounded notification presence messages", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "notification_presence",
					session_id: "session-1",
					visible: true,
				}),
			),
		).toEqual({
			type: "notification_presence",
			session_id: "session-1",
			visible: true,
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "notification_presence",
					session_id: "",
					visible: true,
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "notification_presence",
					session_id: "session-1",
					visible: true,
					extra: true,
				}),
			),
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

	it("accepts only strict durable first-chat notification policies", () => {
		const notificationPolicy = {
			mode: "notify_completion_once",
			scope: "delegation_tree",
			target_device_ids: ["11111111-1111-4111-8111-111111111111"],
		};
		const message = {
			type: "chat",
			text: "notify me",
			session_id: "session-1",
			turn_id: "turn-1",
			notification_policy: notificationPolicy,
		};
		expect(parseClientMessage(JSON.stringify(message))).toEqual(message);

		expect(
			parseClientMessage(JSON.stringify({ ...message, turn_id: undefined })),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					...message,
					notification_policy: { ...notificationPolicy, mode: "default" },
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					...message,
					notification_policy: {
						...notificationPolicy,
						target_device_ids: [],
					},
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					...message,
					notification_policy: { ...notificationPolicy, extra: true },
				}),
			),
		).toBeNull();
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

	it("accepts only bounded Claude MCP control requests", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "mcp_control",
					request_id: "request-1",
					session_id: "session-1",
					server_name: "github",
					action: "reconnect",
				}),
			),
		).toEqual({
			type: "mcp_control",
			request_id: "request-1",
			session_id: "session-1",
			server_name: "github",
			action: "reconnect",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "mcp_control",
					request_id: "request-2",
					session_id: "session-1",
					server_name: "github",
					action: "permission-auto",
				}),
			),
		).toMatchObject({ action: "permission-auto" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "mcp_control",
					request_id: "request-1",
					session_id: "session-1",
					server_name: "github",
					action: "restart",
				}),
			),
		).toBeNull();
	});

	it("requires a server-issued preview before executing a file rewind", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "file_rewind",
					request_id: "request-1",
					session_id: "session-1",
					turn_id: "turn-1",
					action: "preview",
				}),
			),
		).toMatchObject({ type: "file_rewind", action: "preview" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "file_rewind",
					request_id: "request-2",
					session_id: "session-1",
					turn_id: "turn-1",
					action: "execute",
					preview_id: "preview-1",
				}),
			),
		).toMatchObject({
			type: "file_rewind",
			action: "execute",
			preview_id: "preview-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "file_rewind",
					request_id: "request-3",
					session_id: "session-1",
					turn_id: "turn-1",
					action: "execute",
				}),
			),
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

	it("validates exact and session-level background activity controls", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "terminate",
					activity_id: "item-1",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "background_activity_control",
			action: "terminate",
			activity_id: "item-1",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "terminate",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "stop",
					activity_id: "task-1",
				}),
			),
		).toEqual({
			type: "background_activity_control",
			action: "stop",
			activity_id: "task-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "stop",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "background",
				}),
			),
		).toEqual({ type: "background_activity_control", action: "background" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "background_activity_control",
					action: "clean",
				}),
			),
		).toEqual({ type: "background_activity_control", action: "clean" });
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
					request_id: "realtime-request-1",
					mode: "live",
					sdp: "v=0\r\n",
					voice: "marin",
				}),
			),
		).toMatchObject({
			type: "realtime_start",
			request_id: "realtime-request-1",
			mode: "live",
			voice: "marin",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_speak",
					session_id: "session-1",
					request_id: "realtime-request-1",
					mode: "read-aloud",
					text: "Read this response",
				}),
			),
		).toMatchObject({
			type: "realtime_speak",
			request_id: "realtime-request-1",
			mode: "read-aloud",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_speak",
					session_id: "session-1",
					text: "Uncorrelated speech",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_stop",
					session_id: "session-1",
					request_id: "realtime-request-1",
					mode: "live",
				}),
			),
		).toEqual({
			type: "realtime_stop",
			session_id: "session-1",
			request_id: "realtime-request-1",
			mode: "live",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_stop",
					session_id: "session-1",
				}),
			),
		).toEqual({ type: "realtime_stop", session_id: "session-1" });
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_stop",
					session_id: "session-1",
					mode: "unknown",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_start",
					session_id: "session-1",
					request_id: "",
					mode: "live",
					sdp: "v=0\r\n",
				}),
			),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "realtime_stop",
					session_id: "session-1",
					request_id: "x".repeat(257),
					mode: "live",
				}),
			),
		).toBeNull();
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

	it("accepts session-scoped approval reviewer controls", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "chat",
					text: "review this change",
					approvals_reviewer: "auto_review",
				}),
			),
		).toEqual({
			type: "chat",
			text: "review this change",
			approvals_reviewer: "auto_review",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "set_provider",
					provider: "codex",
					approvals_reviewer: "user",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "set_provider",
			provider: "codex",
			approvals_reviewer: "user",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "set_approvals_reviewer",
					reviewer: "auto_review",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "set_approvals_reviewer",
			reviewer: "auto_review",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(JSON.stringify({ type: "set_approvals_reviewer" })),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "set_approvals_reviewer",
					reviewer: "guardian_subagent",
				}),
			),
		).toBeNull();
	});

	it("accepts live provider configuration probes and opaque session modes", () => {
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "probe_provider_config",
					session_id: "session-1",
					agent_cwd: "/tmp/project",
				}),
			),
		).toEqual({
			type: "probe_provider_config",
			session_id: "session-1",
			agent_cwd: "/tmp/project",
		});
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "set_provider_mode",
					mode: "review",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "set_provider_mode",
			mode: "review",
			session_id: "session-1",
		});
		expect(
			parseClientMessage(JSON.stringify({ type: "set_provider_mode" })),
		).toBeNull();
		expect(
			parseClientMessage(
				JSON.stringify({
					type: "restore_provider_mode",
					session_id: "session-1",
				}),
			),
		).toEqual({
			type: "restore_provider_mode",
			session_id: "session-1",
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
