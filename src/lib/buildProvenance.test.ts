import { describe, expect, it } from "vitest";
import {
	type BuildProvenanceReport,
	extractBuildSessionProvenance,
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
});

describe("build provenance HTML", () => {
	it("renders interactive evidence without raw transcript payloads", () => {
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
				},
			],
			commits: [
				{
					sha: "abc123456789",
					shortSha: "abc1234",
					subject: "escape </script><script>alert(1)</script>",
					authorDate: "2026-07-15T00:00:00.000Z",
					commitDate: "2026-07-15T00:00:00.000Z",
					signatureStatus: "G",
					signerFingerprint: "fingerprint",
					additions: 2,
					deletions: 1,
					filesChanged: 1,
					url: null,
					sessionIds: ["thread-1"],
				},
			],
		};

		const html = renderBuildProvenanceHtml(report);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("Direct transcript link");
		expect(html).toContain("gpt-5.6-sol");
		expect(html).toContain("&lt;/script&gt;");
		expect(html).not.toContain("</script><script>alert(1)</script>");
		expect(html).not.toContain("secret prompt contents");
	});
});
