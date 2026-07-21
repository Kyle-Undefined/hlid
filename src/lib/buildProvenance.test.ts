import { describe, expect, it } from "vitest";
import {
	type BuildProvenanceReport,
	extractBuildSessionProvenance,
	extractClaudeBuildSessionProvenance,
	renderBuildProvenanceHtml,
} from "./buildProvenance";

describe("build provenance extraction", () => {
	it("links a commit only from matching tool-call output", () => {
		const session = extractBuildSessionProvenance({
			transcriptPath: "/sessions/rollout.jsonl",
			transcriptSha256: "abc123",
			records: [
				{
					timestamp: "2026-07-15T01:43:22.988Z",
					type: "session_meta",
					payload: {
						id: "thread-1",
						cwd: "/repo/hlid",
						originator: "hlid",
						timestamp: "2026-07-15T01:43:22.988Z",
					},
				},
				{
					timestamp: "2026-07-15T01:43:24.000Z",
					type: "turn_context",
					payload: { model: "gpt-5.6-sol", effort: "high" },
				},
				{
					timestamp: "2026-07-15T01:44:00.000Z",
					type: "event_msg",
					payload: {
						type: "token_count",
						info: {
							total_token_usage: {
								input_tokens: 1200,
								cached_input_tokens: 800,
								output_tokens: 300,
								reasoning_output_tokens: 100,
								total_tokens: 1500,
							},
						},
					},
				},
				{
					timestamp: "2026-07-15T02:00:00.000Z",
					type: "response_item",
					payload: {
						type: "message",
						role: "developer",
						content: "Untrusted text mentions [main deadbee] fake commit",
					},
				},
				{
					timestamp: "2026-07-15T02:01:00.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call",
						call_id: "commit-call",
						name: "exec",
						input:
							'const r = await tools.exec_command({cmd:"bun run validate && git commit -S -m \\"feat: proof\\"",workdir:"/repo/hlid"});',
					},
				},
				{
					timestamp: "2026-07-15T02:01:01.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "commit-call",
						output: [
							{
								type: "input_text",
								text: "Script completed\n[main 41a57ae] feat: proof\n 3 files changed",
							},
						],
					},
				},
				{
					timestamp: "2026-07-15T02:02:00.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call",
						call_id: "search-call",
						name: "exec",
						input: JSON.stringify({
							cmd: "rg -n 'git commit|deadbee' rollout.jsonl",
						}),
					},
				},
				{
					timestamp: "2026-07-15T02:02:01.000Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "search-call",
						output: "Prior evidence: [main deadbee] fake commit",
					},
				},
			],
		});

		expect(session).toMatchObject({
			threadId: "thread-1",
			cwd: "/repo/hlid",
			originator: "hlid",
			models: ["gpt-5.6-sol"],
			efforts: ["high"],
			transcriptSha256: "abc123",
		});
		expect(session?.commitEvidence).toEqual([
			expect.objectContaining({
				sha: "41a57ae",
				callId: "commit-call",
				command: expect.stringContaining("git commit"),
				output: expect.stringContaining("[main 41a57ae] feat: proof"),
			}),
		]);
		expect(session?.validationCommands).toEqual([
			expect.stringContaining("bun run validate"),
		]);
		expect(session?.toolCalls).toBe(2);
		expect(session?.toolCounts).toEqual([{ name: "exec", count: 2 }]);
		expect(session?.usage).toEqual({
			inputTokens: 1200,
			cachedInputTokens: 800,
			outputTokens: 300,
			reasoningOutputTokens: 100,
			totalTokens: 1500,
		});
		expect(session?.commitEvidence.some((item) => item.sha === "deadbee")).toBe(
			false,
		);
	});

	it("supports function-call shaped Codex command records", () => {
		const session = extractBuildSessionProvenance({
			transcriptPath: "rollout.jsonl",
			transcriptSha256: "hash",
			records: [
				{
					type: "session_meta",
					payload: { session_id: "thread-2", cwd: "/repo/hlid" },
				},
				{
					timestamp: "2026-07-16T00:00:00.000Z",
					type: "response_item",
					payload: {
						type: "function_call",
						call_id: "call-2",
						name: "exec_command",
						arguments: JSON.stringify({
							cmd: "git commit -m 'feat: old shape'",
						}),
					},
				},
				{
					timestamp: "2026-07-16T00:00:01.000Z",
					type: "response_item",
					payload: {
						type: "function_call_output",
						call_id: "call-2",
						output: "[main abcdef1] feat: old shape",
					},
				},
			],
		});

		expect(session?.commitEvidence[0]).toMatchObject({
			sha: "abcdef1",
			callId: "call-2",
		});
	});

	it("extracts owned Claude tools without double counting streamed snapshots", () => {
		const tool = {
			type: "tool_use",
			id: "tool-1",
			name: "Bash",
			input: { command: "bun run validate && git commit -m test" },
		};
		const session = extractClaudeBuildSessionProvenance({
			threadId: "claude-1",
			startedAt: "2026-07-15T01:00:00.000Z",
			endedAt: "2026-07-15T02:00:00.000Z",
			cwd: "hlid",
			originator: "Claude CLI",
			models: ["claude-fable-5"],
			usage: {
				inputTokens: 900,
				cachedInputTokens: 700,
				outputTokens: 100,
				reasoningOutputTokens: 0,
				totalTokens: 1000,
			},
			assistantMessageIds: ["message-1"],
			transcriptPath: "claude-1.jsonl",
			transcriptSha256: "hash",
			records: [
				{
					type: "assistant",
					timestamp: "2026-07-15T01:30:00.000Z",
					effort: "high",
					message: { id: "message-1", content: [tool] },
				},
				{
					type: "assistant",
					timestamp: "2026-07-15T01:30:01.000Z",
					message: { id: "message-1", content: [tool] },
				},
				{
					type: "assistant",
					timestamp: "2026-07-15T01:31:00.000Z",
					message: {
						id: "unowned-message",
						content: [
							{
								type: "tool_use",
								id: "tool-2",
								name: "Read",
								input: {},
							},
						],
					},
				},
				{
					type: "user",
					timestamp: "2026-07-15T01:30:02.000Z",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool-1",
								content:
									"[main abcdef1] test commit\n 2 files changed, 3 insertions(+), 1 deletion(-)",
							},
						],
					},
				},
			],
		});

		expect(session.toolCalls).toBe(1);
		expect(session.toolCounts).toEqual([{ name: "Bash", count: 1 }]);
		expect(session.validationCommands).toEqual(["bun run validate"]);
		expect(session.commitEvidence).toMatchObject([
			{ sha: "abcdef1", callId: "tool-1" },
		]);
	});
});

describe("build provenance HTML", () => {
	it("renders compact session-first evidence without raw transcript payloads", () => {
		const report: BuildProvenanceReport = {
			title: "Hlið proof",
			generatedAt: "2026-07-18T00:00:00.000Z",
			repository: {
				name: "hlid",
				path: "/repo/hlid",
				url: "https://github.com/example/hlid",
				baseline: "base123456789",
				head: "head123456789",
			},
			window: {
				since: "2026-07-13T16:00:00.000Z",
				until: "2026-07-22T00:00:00.000Z",
			},
			sessions: [
				{
					threadId: "thread-1",
					startedAt: "2026-07-15T00:00:00.000Z",
					endedAt: "2026-07-15T01:00:00.000Z",
					cwd: "/repo/hlid",
					originator: "hlid",
					models: ["gpt-5.6-sol"],
					efforts: ["high"],
					transcriptPath: "/private/rollout.jsonl",
					transcriptSha256: "hash",
					commitEvidence: [],
					validationCommands: [],
					toolCalls: 4,
					toolCounts: [{ name: "exec", count: 4 }],
					usage: {
						inputTokens: 1000,
						cachedInputTokens: 700,
						outputTokens: 200,
						reasoningOutputTokens: 50,
						totalTokens: 1200,
					},
					inBuildWeek: true,
				},
			],
			commits: [
				{
					sha: "older123456789",
					shortSha: "older12",
					subject: "older linked commit",
					authorDate: "2026-07-14T00:00:00.000Z",
					commitDate: "2026-07-14T00:00:00.000Z",
					authorName: "Kyle",
					authorEmail: "kyle@example.com",
					coAuthors: [],
					signatureStatus: "G",
					signerFingerprint: "fingerprint",
					additions: 1,
					deletions: 0,
					filesChanged: 1,
					url: null,
					sessionIds: ["thread-1"],
					inBuildWeek: true,
				},
				{
					sha: "abc123456789",
					shortSha: "abc1234",
					subject: "escape </script><script>alert(1)</script>",
					authorDate: "2026-07-15T00:00:00.000Z",
					commitDate: "2026-07-15T00:00:00.000Z",
					authorName: "Kyle",
					authorEmail: "kyle@example.com",
					coAuthors: [
						{
							name: "Claude Fable 5",
							email: "noreply@anthropic.com",
						},
					],
					signatureStatus: "G",
					signerFingerprint: "fingerprint",
					additions: 2,
					deletions: 1,
					filesChanged: 1,
					url: null,
					sessionIds: ["thread-1"],
					inBuildWeek: true,
				},
			],
			contributors: [
				{
					name: "Kyle",
					email: "kyle@example.com",
					aliases: [],
					commits: 2,
					buildWeekCommits: 2,
					primaryCommits: 2,
					coauthoredCommits: 0,
					sessionLinkedCommits: 0,
					buildWeekSessionLinkedCommits: 0,
				},
				{
					name: "Claude (Anthropic)",
					email: "noreply@anthropic.com",
					aliases: ["Claude Fable 5"],
					commits: 1,
					buildWeekCommits: 1,
					primaryCommits: 0,
					coauthoredCommits: 1,
					sessionLinkedCommits: 1,
					buildWeekSessionLinkedCommits: 1,
				},
			],
		};

		const html = renderBuildProvenanceHtml(report);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("GPT-5.6 build total");
		expect(html).toContain("gpt-5.6-sol");
		expect(html).toContain('title="1,200">1.2K</b>');
		expect(html).toContain("1,200 exact");
		expect(html.match(/1,200 exact/g)).toHaveLength(1);
		expect(html).toContain("2 commits");
		expect(html).toContain("What the sessions shipped");
		expect(html).toContain("Transcript proof and usage detail");
		expect(html).toContain('class="commit-branch build-week"');
		expect(html.indexOf("alert(1)")).toBeLessThan(
			html.indexOf("older linked commit"),
		);
		expect(html).toContain("Build Week");
		expect(html).toContain('class="method-note"');
		expect(html).toContain("Contributors");
		expect(html).toContain("GitHub-recognized co-author");
		expect(html).toContain("Claude (Anthropic)");
		expect(html).toContain("&lt;/script&gt;");
		expect(html).not.toContain("</script><script>alert(1)</script>");
		expect(html).not.toContain("secret prompt contents");
	});
});
