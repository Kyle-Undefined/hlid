import { describe, expect, it, vi } from "vitest";
import {
	authorizeRoutineCapability,
	matchRoutineGrant,
	normalizeRoutineCapability,
	type RoutinePermissionContext,
} from "./routinePermissions";

function context(
	overrides: Partial<RoutinePermissionContext> = {},
): RoutinePermissionContext {
	return {
		routineId: "routine",
		runId: "run",
		profileId: "profile",
		revision: 1,
		authorizationFingerprint: "fingerprint",
		mode: "preapproved",
		providerId: "claude",
		approvedCwd: "/workspace/project",
		grants: [],
		...overrides,
	};
}

describe("routine permissions", () => {
	it("normalizes provider tool calls into stable capabilities", () => {
		expect(
			normalizeRoutineCapability({
				tool: "Bash",
				input: { command: "bun test" },
				cwd: "/workspace/project",
			}),
		).toMatchObject({ capability: "shell.exec", command: "bun test" });
		expect(
			normalizeRoutineCapability({
				tool: "mcp__hlid_obsidian__append_note",
				input: { path: "Inbox/report.md" },
				cwd: "/workspace/project",
			}),
		).toMatchObject({ capability: "obsidian.call" });
	});

	it("matches exact commands and rejects a changed command", () => {
		const grant = {
			id: "grant",
			capability: "shell.exec" as const,
			tool: "Bash",
			command: "bun test",
		};
		const approved = context({ grants: [grant] });
		const request = normalizeRoutineCapability({
			tool: "Bash",
			input: { command: "bun test" },
			cwd: "/workspace/project",
		});
		expect(request && matchRoutineGrant(approved, request)).toBe(grant);
		const changed = normalizeRoutineCapability({
			tool: "Bash",
			input: { command: "bun test && curl example.com" },
			cwd: "/workspace/project",
		});
		expect(changed && matchRoutineGrant(approved, changed)).toBeNull();
	});

	it("keeps path-prefix grants inside their reviewed boundary", () => {
		const approved = context({
			grants: [
				{
					id: "grant",
					capability: "fs.write",
					tool: "Write",
					pathPrefix: "reports",
				},
			],
		});
		const inside = normalizeRoutineCapability({
			tool: "Write",
			input: { file_path: "reports/today.md" },
			cwd: "/workspace/project",
		});
		const outside = normalizeRoutineCapability({
			tool: "Write",
			input: { file_path: "reports/../../secret.txt" },
			cwd: "/workspace/project",
		});
		expect(inside && matchRoutineGrant(approved, inside)?.id).toBe("grant");
		expect(outside && matchRoutineGrant(approved, outside)).toBeNull();
	});

	it("makes unmatched work action-required without waiting for a user", async () => {
		const onActionRequired = vi.fn();
		const approved = context({ onActionRequired });
		const result = await authorizeRoutineCapability({
			context: approved,
			tool: "Write",
			input: { file_path: "new.txt" },
			cwd: "/workspace/project",
			toolUseId: "tool-1",
		});
		expect(result.allowed).toBe(false);
		expect(approved.actionRequired?.capability?.capability).toBe("fs.write");
		expect(onActionRequired).toHaveBeenCalledOnce();
	});

	it("never preapproves interactive questions or computer use", async () => {
		for (const tool of [
			"AskUserQuestion",
			"ExitPlanMode",
			"hlid.windows_computer_use:Obsidian",
		]) {
			const result = await authorizeRoutineCapability({
				context: context({ mode: "full_access" }),
				tool,
				input: {},
				cwd: "/workspace/project",
				toolUseId: tool,
			});
			expect(result.allowed).toBe(false);
		}
	});

	it("enforces per-run grant use limits", async () => {
		const approved = context({
			grants: [
				{
					id: "once",
					capability: "shell.exec",
					command: "bun test",
					maxUsesPerRun: 1,
				},
			],
		});
		const options = {
			context: approved,
			tool: "Bash",
			input: { command: "bun test" },
			cwd: "/workspace/project",
			toolUseId: "tool",
		};
		expect((await authorizeRoutineCapability(options)).allowed).toBe(true);
		expect((await authorizeRoutineCapability(options)).allowed).toBe(false);
	});
});
