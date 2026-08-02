// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import { workflowResumePrompt } from "#/lib/workflowRuns";
import type { ToolEventMessage } from "#/server/protocol";

const { mockEnqueueChat, mockLoadToolEventDetail, mockWsSend } = vi.hoisted(
	() => ({
		mockEnqueueChat: vi.fn(),
		mockLoadToolEventDetail: vi.fn(),
		mockWsSend: vi.fn(),
	}),
);

vi.mock("#/hooks/toolEventDetailStore", () => ({
	loadToolEventDetail: mockLoadToolEventDetail,
}));
vi.mock("#/hooks/wsStore", () => ({
	enqueueChat: mockEnqueueChat,
	send: mockWsSend,
}));

import {
	looksLikeMarkdown,
	stripReadLineNumbers,
	ToolBlock,
} from "./ToolBlock";

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
	mockEnqueueChat.mockReset();
	mockLoadToolEventDetail.mockReset();
	mockWsSend.mockReset();
});

function makeEvent(overrides?: Partial<ToolEventMessage>): ToolEventMessage {
	return {
		type: "tool_event",
		id: "te1",
		name: "Bash",
		input: { command: "ls /tmp" },
		...overrides,
	};
}

describe("ToolBlock — collapsed", () => {
	it("renders tool name and input pills", () => {
		render(<ToolBlock event={makeEvent()} />);
		expect(screen.getByText("Bash")).not.toBeNull();
		expect(screen.getByText(/command:/)).not.toBeNull();
	});

	it("constrains long unbroken command pills to the tool row width", () => {
		render(
			<ToolBlock
				event={makeEvent({ input: { command: "x".repeat(2_000) } })}
			/>,
		);
		const button = screen.getByRole("button");
		const pill = screen.getByText(/command:/);
		expect(button.className).toContain("min-w-0");
		expect(button.className).toContain("overflow-hidden");
		expect(pill.className).toContain("max-w-full");
		expect(pill.className).toContain("truncate");
		expect(pill.textContent?.length).toBeLessThan(200);
		fireEvent.click(button);
		const expandedValue = screen.getAllByText("x".repeat(2_000)).at(-1);
		expect(expandedValue?.className).toContain("flex-1");
		expect(expandedValue?.className).toContain("break-all");
	});

	it("shows result preview line when result is present", () => {
		render(<ToolBlock event={makeEvent({ result: "file1\nfile2\nfile3" })} />);
		expect(screen.getByText("file1")).not.toBeNull();
		expect(screen.queryByText("file2")).toBeNull();
	});

	it("does not show result preview when no result", () => {
		render(<ToolBlock event={makeEvent()} />);
		expect(screen.queryByText("(empty)")).toBeNull();
	});

	it("renders error indicator on isError", () => {
		render(
			<ToolBlock
				event={makeEvent({ result: "permission denied", isError: true })}
			/>,
		);
		expect(screen.getByLabelText(/error/i)).not.toBeNull();
		expect(screen.getByText("permission denied")).not.toBeNull();
	});
});

describe("ToolBlock — specialized event dispatch", () => {
	it("renders Hlid visualization results inline without raw tool chrome", () => {
		const result = JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "0591f46e-b4b3-4bfb-9aa2-14f65d625209",
			filename: "latency-explorer.html",
			title: "Latency explorer",
		});
		render(
			<ToolBlock
				providerId="codex"
				sessionId="session-1"
				expandedVisualizationEventId="te1"
				event={makeEvent({
					name: "mcp__hlid__create_visualization",
					input: { prompt: "Show the response path" },
					result,
					subagent: {
						provider: "codex",
						agentId: "visualization-worker-1",
						label: "Windows Visualize",
						status: "completed",
						currentStep: "Visualization ready",
						startedAtMs: 1,
						endedAtMs: 2,
					},
				})}
			/>,
		);

		const frame = screen.getByTitle("Latency explorer");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(screen.queryByText("mcp__hlid__create_visualization")).toBeNull();
		expect(screen.queryByText(result)).toBeNull();
		expect(screen.queryByText(/prompt:/)).toBeNull();
	});

	it("does not specialize another tool that returns visualization-shaped JSON", () => {
		const result = JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "attachment-1",
			filename: "latency-explorer.html",
			title: "Latency explorer",
		});
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__other__render",
					result,
				})}
			/>,
		);

		expect(screen.getByText("mcp__other__render")).not.toBeNull();
		expect(screen.queryByTitle("Latency explorer")).toBeNull();
	});

	it("does not specialize visualization tool names outside Codex sessions", () => {
		const result = JSON.stringify({
			type: "hlid_visualization",
			attachment_id: "attachment-1",
			filename: "latency-explorer.html",
			title: "Latency explorer",
		});
		render(
			<ToolBlock
				providerId="claude"
				sessionId="session-1"
				event={makeEvent({
					name: "mcp__hlid__create_visualization",
					result,
				})}
			/>,
		);

		expect(screen.getByText("mcp__hlid__create_visualization")).not.toBeNull();
		expect(screen.queryByTitle("Latency explorer")).toBeNull();
	});

	it("routes capture and control events to the Project Preview capture row", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__capture_project_preview",
					input: { viewport: "mobile" },
					result: JSON.stringify({
						preview_id: "preview-1",
						path: "/settings",
						viewport: "mobile",
						width: 390,
						height: 844,
						full_page: false,
						size_bytes: 1024,
					}),
				})}
			/>,
		);

		expect(
			screen.getByText("Project Preview captured for agent"),
		).not.toBeNull();
		expect(screen.getByText(/mobile · 390×844 · \/settings/i)).not.toBeNull();
		expect(screen.queryByText("mcp__hlid__capture_project_preview")).toBeNull();
	});

	it("routes lifecycle events to the Project Preview lifecycle row", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__start_project_preview",
					input: { port: 4173 },
				})}
			/>,
		);

		expect(screen.getByText("Starting Project Preview")).not.toBeNull();
		expect(screen.getByText("starting")).not.toBeNull();
		expect(screen.queryByText("mcp__hlid__start_project_preview")).toBeNull();
	});

	it.each([
		["control_project_preview", "Controlling Project Preview"],
		["inspect_project_preview", "Project Preview"],
		["stop_project_preview", "Project Preview"],
	] as const)("routes %s through its specialized Preview row", (name, label) => {
		render(
			<ToolBlock
				event={makeEvent({
					name: `mcp__hlid__${name}`,
				})}
			/>,
		);

		expect(screen.getByText(label)).not.toBeNull();
		expect(screen.queryByText(`mcp__hlid__${name}`)).toBeNull();
	});

	it("gives subagent rendering precedence over a Preview-shaped tool name", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__capture_project_preview",
					subagent: {
						provider: "codex",
						agentId: "preview-child",
						kind: "agent",
						name: "Preview specialist",
						status: "completed",
						startedAtMs: 1,
						endedAtMs: 2,
					},
				})}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: "Preview specialist completed",
			}),
		).not.toBeNull();
		expect(screen.queryByText("Project Preview captured for agent")).toBeNull();
	});
});

describe("ToolBlock — Hlid orchestration audit rows", () => {
	it.each([
		["delegate_hlid_agent", "Delegate child", "CREATED"],
		["list_hlid_agents", "List children", "CHECKED"],
		["inspect_hlid_agent", "Inspect child", "CHECKED"],
		["wait_hlid_agent", "Wait for child", "CHECKED"],
		["steer_hlid_agent", "Steer child", "SENT"],
		["cancel_hlid_agent", "Cancel child", "REQUESTED"],
		["resume_hlid_agent", "Resume child", "STARTED"],
	] as const)("renders %s as a compact expandable audit action", (toolName, label, status) => {
		const list = toolName === "list_hlid_agents";
		render(
			<ToolBlock
				event={makeEvent({
					name: `mcp__hlid__${toolName}`,
					input: list
						? {}
						: {
								id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
								task: "Review the provider boundary",
								instruction: "Check the cancellation edge case",
								provider: "codex",
							},
					result: JSON.stringify(
						list
							? [{ id: "delegation-1" }, { id: "delegation-2" }]
							: {
									id: "7c0eea4d-f74e-45c8-8674-a535fbb4412b",
									status: "running",
								},
					),
				})}
			/>,
		);

		expect(screen.getByText(label)).not.toBeNull();
		expect(screen.getByText(status)).not.toBeNull();
		expect(screen.queryByText("Hlid child")).toBeNull();
		expect(screen.queryByRole("link", { name: /open child/i })).toBeNull();
		if (list) expect(screen.getByText("2 children")).not.toBeNull();

		const toggle = screen.getByRole("button", {
			name: `${label} details`,
			expanded: false,
		});
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(
			screen.getByText(/Recorded tool call · response at call time/i),
		).not.toBeNull();
		expect(document.querySelector("pre")?.textContent).toContain(
			list ? "delegation-1" : '"status":"running"',
		);
		if (!list) {
			expect(
				screen.getByText("7c0eea4d-f74e-45c8-8674-a535fbb4412b"),
			).not.toBeNull();
		}
	});

	it("does not present a control response as the child's live lifecycle", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__cancel_hlid_agent",
					input: { id: "delegation-1" },
					result: JSON.stringify({
						id: "delegation-1",
						status: "running",
						progress_text: "Cancellation requested by parent",
					}),
				})}
			/>,
		);

		expect(screen.getByText("REQUESTED")).not.toBeNull();
		expect(screen.queryByText("RUNNING")).toBeNull();
		expect(screen.queryByText("Cancellation requested by parent")).toBeNull();
	});

	it("keeps an orchestration action failure visible and bounded", () => {
		const error = `Cancellation request failed ${"x".repeat(500)}`;
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__cancel_hlid_agent",
					input: { id: "delegation-1" },
					result: error,
					isError: true,
				})}
			/>,
		);

		expect(screen.getByText("FAILED")).not.toBeNull();
		const detail = screen.getByText(/Cancellation request failed/);
		expect(detail.textContent?.length).toBe(240);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Cancel child details",
				expanded: false,
			}),
		);
		expect(screen.getByText(/^Error$/i)).not.toBeNull();
		expect(document.querySelector("pre")?.textContent).toBe(error);
	});

	it("hydrates a truncated historical orchestration response on expansion", async () => {
		mockLoadToolEventDetail.mockResolvedValue({
			result: JSON.stringify({
				id: "delegation-1",
				status: "completed",
				result: "The complete persisted child report",
			}),
			isError: false,
		});
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__inspect_hlid_agent",
					input: { id: "delegation-1" },
					result: '{"id":"delegation-1","status":"completed","res',
					resultLength: 120,
					resultTruncated: true,
					detailSessionId: "parent-session",
				})}
			/>,
		);

		expect(mockLoadToolEventDetail).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: "Inspect child details",
				expanded: false,
			}),
		);
		expect(screen.getByText("Loading full result…")).not.toBeNull();
		await waitFor(() => {
			expect(document.querySelector("pre")?.textContent).toContain(
				"The complete persisted child report",
			);
		});
		expect(mockLoadToolEventDetail).toHaveBeenCalledWith(
			"parent-session",
			"te1",
		);
	});

	it("uses a mobile-safe grid instead of a competing full-width child link", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "mcp__hlid__delegate_hlid_agent",
					input: {
						task: "A long delegated task that still belongs inside the row",
						provider: "claude",
					},
					result: JSON.stringify({ id: "delegation-1" }),
				})}
			/>,
		);

		const row = screen.getByText("Delegate child").closest(".grid");
		expect(row?.className).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
		expect(row?.className).toContain("min-w-0");
	});
});

describe("ToolBlock — native workflows", () => {
	it("builds an explicit same-workflow resume prompt", () => {
		const prompt = workflowResumePrompt({
			provider: "claude",
			agentId: "workflow-task",
			taskId: "workflow-task",
			kind: "workflow",
			name: "Repository audit",
			status: "interrupted",
			workflowRunId: "run-1",
			workflowStopConfirmed: true,
			workflowScriptPath: "/tmp/workflow.js",
			startedAtMs: 1,
		});
		expect(prompt).toContain(
			'resumeFromRunId set to "run-1". Reuse the persisted scriptPath "/tmp/workflow.js".',
		);
		expect(prompt).toContain(
			'Hlid requested the stop and observed native workflow task "workflow-task" enter the stopped state.',
		);
		expect(prompt).toContain(
			"Continue that workflow rather than starting a new one.",
		);
		expect(prompt).not.toContain("Claude already confirmed");
		expect(prompt).not.toContain("preflight");
	});

	it("sends deterministic native stop control to the owning session", () => {
		render(
			<ToolBlock
				sessionId="session-1"
				event={makeEvent({
					name: "Workflow",
					subagent: {
						provider: "claude",
						agentId: "workflow-stop-task",
						taskId: "workflow-stop-task",
						kind: "workflow",
						name: "Repository audit",
						status: "running",
						startedAtMs: 1,
					},
				})}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /repository audit running/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop workflow" }));
		expect(mockWsSend).toHaveBeenCalledWith({
			type: "workflow_control",
			action: "stop",
			task_id: "workflow-stop-task",
			session_id: "session-1",
		});
	});

	it("queues resume as a visible native Claude turn", () => {
		render(
			<ToolBlock
				sessionId="session-1"
				event={makeEvent({
					name: "Workflow",
					subagent: {
						provider: "claude",
						agentId: "workflow-resume-task",
						taskId: "workflow-resume-task",
						kind: "workflow",
						name: "Repository audit",
						status: "interrupted",
						workflowRunId: "run-1",
						workflowStopConfirmed: true,
						startedAtMs: 1,
						endedAtMs: 2,
					},
				})}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /repository audit interrupted/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
		expect(mockEnqueueChat).toHaveBeenCalledWith(
			expect.objectContaining({
				session_id: "session-1",
				text: expect.stringContaining('resumeFromRunId set to "run-1"'),
			}),
		);
	});

	it("does not control a workflow after the session switches providers", () => {
		render(
			<ToolBlock
				sessionId="session-1"
				providerId="codex"
				event={makeEvent({
					name: "Workflow",
					subagent: {
						provider: "claude",
						agentId: "stale-workflow",
						taskId: "stale-workflow",
						kind: "workflow",
						name: "Repository audit",
						status: "completed",
						workflowRunId: "run-1",
						startedAtMs: 1,
						endedAtMs: 2,
					},
				})}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /repository audit completed/i }),
		);
		expect(
			screen.queryByRole("button", { name: "Resume workflow" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop workflow" })).toBeNull();
	});
});

describe("ToolBlock — expanded", () => {
	it("expand reveals full result text", () => {
		render(<ToolBlock event={makeEvent({ result: "line1\nline2\nline3" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		const pre = document.querySelector("pre");
		expect(pre?.textContent).toBe("line1\nline2\nline3");
	});

	it("expand renders Result heading on success", () => {
		render(<ToolBlock event={makeEvent({ result: "ok" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/^Result$/i)).not.toBeNull();
	});

	it("expand renders Error heading on isError", () => {
		render(<ToolBlock event={makeEvent({ result: "boom", isError: true })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/^Error$/i)).not.toBeNull();
	});

	it("renders Reasoning as prose without an empty input panel", () => {
		render(
			<ToolBlock
				event={makeEvent({
					name: "Reasoning",
					input: {},
					result: "Checking the repo layout before editing.",
				})}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getAllByText(/^Reasoning$/i)).toHaveLength(2);
		expect(
			screen.getByText("Checking the repo layout before editing."),
		).not.toBeNull();
		expect(document.querySelector("pre")).toBeNull();
	});

	it("keeps oversized results complete without building a wrapped or markdown DOM", () => {
		const result = `# Large result\n${"x".repeat(25_000)}`;
		render(<ToolBlock event={makeEvent({ result })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		const viewer = screen.getByLabelText("Full tool result");
		expect(viewer).toBeInstanceOf(HTMLTextAreaElement);
		expect((viewer as HTMLTextAreaElement).value).toBe(result);
		expect(viewer.getAttribute("wrap")).toBe("off");
		expect(screen.queryByRole("heading", { name: "Large result" })).toBeNull();
	});

	it("uses the native scroll viewer for oversized tool inputs", () => {
		const command = "x".repeat(25_000);
		render(<ToolBlock event={makeEvent({ input: { command } })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		const viewer = screen.getByLabelText("command tool input");
		expect(viewer).toBeInstanceOf(HTMLTextAreaElement);
		expect((viewer as HTMLTextAreaElement).value).toBe(command);
	});

	it("hydrates a truncated historical result only when expanded", async () => {
		mockLoadToolEventDetail.mockResolvedValue({
			result: "complete result\nwith every line",
			isError: false,
		});
		render(
			<ToolBlock
				event={makeEvent({
					result: "complete result\nwith",
					resultLength: 31,
					resultTruncated: true,
					detailSessionId: "session-1",
				})}
			/>,
		);
		expect(mockLoadToolEventDetail).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Loading full result…")).not.toBeNull();
		await waitFor(() => {
			expect(document.querySelector("pre")?.textContent).toBe(
				"complete result\nwith every line",
			);
		});
		expect(mockLoadToolEventDetail).toHaveBeenCalledWith("session-1", "te1");
	});

	it("offers a retry when historical detail hydration fails", async () => {
		mockLoadToolEventDetail
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ result: "recovered" });
		render(
			<ToolBlock
				event={makeEvent({
					result: "preview",
					resultLength: 500,
					resultTruncated: true,
					detailSessionId: "session-1",
				})}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		await screen.findByText("offline");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => {
			expect(document.querySelector("pre")?.textContent).toBe("recovered");
		});
		expect(mockLoadToolEventDetail).toHaveBeenCalledTimes(2);
	});

	it("releases hydrated detail when closed and reloads it on demand", async () => {
		mockLoadToolEventDetail
			.mockResolvedValueOnce({ result: "first hydrated result" })
			.mockResolvedValueOnce({ result: "second hydrated result" });
		render(
			<ToolBlock
				event={makeEvent({
					result: "preview",
					resultLength: 500,
					resultTruncated: true,
					detailSessionId: "session-1",
				})}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { expanded: false }));
		await waitFor(() => {
			expect(document.querySelector("pre")?.textContent).toBe(
				"first hydrated result",
			);
		});
		fireEvent.click(screen.getByRole("button", { expanded: true }));
		expect(document.querySelector("pre")).toBeNull();

		fireEvent.click(screen.getByRole("button", { expanded: false }));
		await waitFor(() => {
			expect(document.querySelector("pre")?.textContent).toBe(
				"second hydrated result",
			);
		});
		expect(mockLoadToolEventDetail).toHaveBeenCalledTimes(2);
	});
});

describe("looksLikeMarkdown", () => {
	it("detects ATX headings", () => {
		expect(looksLikeMarkdown("# Title\nbody")).toBe(true);
		expect(looksLikeMarkdown("## Sub")).toBe(true);
	});
	it("detects fenced code blocks", () => {
		expect(looksLikeMarkdown("foo\n```js\nx\n```")).toBe(true);
	});
	it("detects bullet lists", () => {
		expect(looksLikeMarkdown("- one\n- two")).toBe(true);
		expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
	});
	it("detects markdown tables", () => {
		expect(looksLikeMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(true);
	});
	it("detects link with brackets", () => {
		expect(looksLikeMarkdown("see [docs](https://x.y)")).toBe(true);
	});
	it("detects multiple bold spans", () => {
		expect(looksLikeMarkdown("**a** and **b**")).toBe(true);
	});
	it("rejects single bold span (too weak)", () => {
		expect(looksLikeMarkdown("**only**")).toBe(false);
	});
	it("rejects plain bash output", () => {
		expect(looksLikeMarkdown("file1\nfile2\nfile3")).toBe(false);
	});
	it("rejects JSON", () => {
		expect(looksLikeMarkdown('{"a": 1, "b": [2, 3]}')).toBe(false);
	});
	it("rejects empty", () => {
		expect(looksLikeMarkdown("")).toBe(false);
	});
});

describe("stripReadLineNumbers", () => {
	it("strips '   N\\t' prefix from Read tool output", () => {
		const input = "     1\t# Title\n     2\t\n     3\tBody.";
		expect(stripReadLineNumbers(input)).toBe("# Title\n\nBody.");
	});

	it("handles tabs without leading whitespace", () => {
		expect(stripReadLineNumbers("1\tfoo\n2\tbar")).toBe("foo\nbar");
	});

	it("leaves plain text unchanged when no prefix", () => {
		const input = "no line numbers here\njust text";
		expect(stripReadLineNumbers(input)).toBe(input);
	});

	it("does not mangle output when only one line happens to match", () => {
		const input = "1\tfoo\nnormal line\nanother normal";
		expect(stripReadLineNumbers(input)).toBe(input);
	});

	it("handles empty string", () => {
		expect(stripReadLineNumbers("")).toBe("");
	});
});

describe("ToolBlock — Read tool markdown rendering", () => {
	it("strips line numbers and renders markdown for Read of a markdown file", () => {
		const readme =
			"     1\t# Hlið\n     2\t\n     3\t*Short for Hliðskjálf.*\n     4\t\n     5\t- one\n     6\t- two";
		render(<ToolBlock event={makeEvent({ name: "Read", result: readme })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		// Heading rendered, line numbers gone
		expect(screen.getByText("Hlið").tagName).toBe("H1");
		expect(screen.queryByText(/^\s*1\s*$/)).toBeNull();
	});
});

describe("ToolBlock — markdown result rendering", () => {
	it("renders <pre> for plain text result", () => {
		render(<ToolBlock event={makeEvent({ result: "line1\nline2" })} />);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(document.querySelector("pre")).not.toBeNull();
	});

	it("renders MarkdownBody for markdown-shaped result", () => {
		render(
			<ToolBlock
				event={makeEvent({ result: "# Heading\n\n- item 1\n- item 2" })}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Heading").tagName).toBe("H1");
		// pre should NOT be used for the markdown-rendered result
		const pres = document.querySelectorAll("pre");
		expect(pres.length).toBe(0);
	});

	it("error result always uses <pre> regardless of markdown", () => {
		render(
			<ToolBlock event={makeEvent({ result: "# heading", isError: true })} />,
		);
		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(document.querySelector("pre")).not.toBeNull();
	});
});

describe("ToolBlock — permissionLabel", () => {
	it("shows label when provided", () => {
		render(<ToolBlock event={makeEvent()} permissionLabel="APPROVED" />);
		expect(screen.getByText("APPROVED")).not.toBeNull();
	});
});

describe("ToolBlock — task activity", () => {
	it("renders a collapsed progress summary and expands to the task rows", () => {
		render(
			<ToolBlock
				sessionId="task-session-1"
				event={makeEvent({
					id: "task-ui-1",
					name: "update_plan",
					input: { plan: [] },
					result: "Plan updated",
					taskActivity: {
						kind: "tasks",
						source: "codex-plan",
						operation: "snapshot",
						explanation: "Implementation order",
						items: [
							{ subject: "Write parser", status: "completed" },
							{
								subject: "Render card",
								activeForm: "Rendering Raven card",
								status: "in_progress",
							},
						],
					},
				})}
			/>,
		);

		const button = screen.getByRole("button", {
			name: "Plan task activity details",
			expanded: false,
		});
		expect(screen.getByText("1/2 done · Rendering Raven card")).not.toBeNull();
		expect(screen.queryByText("Write parser")).toBeNull();
		fireEvent.click(button);
		expect(screen.getByText("Write parser")).not.toBeNull();
		expect(screen.getByText("Render card")).not.toBeNull();
		expect(screen.getByText("Implementation order")).not.toBeNull();
		expect(screen.getByText("Tool details")).not.toBeNull();
	});

	it("retains a manual task-card expansion across a remount", () => {
		const event = makeEvent({
			id: "task-ui-remount",
			name: "TaskList",
			input: {},
			result: "done",
			taskActivity: {
				kind: "tasks",
				source: "claude-task-store",
				operation: "list",
				items: [{ id: "8", subject: "Persist open state", status: "pending" }],
			},
		});
		const first = render(
			<ToolBlock sessionId="task-session-2" event={event} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Tasks task activity details" }),
		);
		expect(screen.getByText("Persist open state")).not.toBeNull();
		first.unmount();
		render(<ToolBlock sessionId="task-session-2" event={event} />);
		expect(
			screen.getByRole("button", {
				name: "Tasks task activity details",
				expanded: true,
			}),
		).not.toBeNull();
		expect(screen.getByText("Persist open state")).not.toBeNull();
	});
});
