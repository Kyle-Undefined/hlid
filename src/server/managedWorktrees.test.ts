import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	createManagedWorktree,
	inspectManagedWorktreeCleanup,
	removeManagedWorktree,
} from "./managedWorktrees";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args]);
	return result.stdout.trim();
}

async function repository(): Promise<{ root: string; workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), "hlid-worktree-test-"));
	roots.push(root, join(dirname(root), ".hlid-worktrees", basename(root)));
	await git(root, "init");
	await git(root, "config", "user.email", "hlid@example.test");
	await git(root, "config", "user.name", "Hlid Test");
	const workspace = join(root, "packages", "app");
	await mkdir(workspace, { recursive: true });
	await writeFile(join(workspace, "tracked.txt"), "committed\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "base");
	return { root, workspace };
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

describe("managed delegation worktrees", () => {
	it("requires an explicit worktree choice for a dirty source and excludes those changes", async () => {
		const { workspace } = await repository();
		await writeFile(join(workspace, "tracked.txt"), "dirty\n");
		await writeFile(join(workspace, "untracked.txt"), "source only\n");

		await expect(
			createManagedWorktree(workspace, "11111111-2222-3333-4444-555555555555", {
				explicit: false,
			}),
		).rejects.toThrow(/workspace_mode=shared/);

		const receipt = await createManagedWorktree(
			workspace,
			"11111111-2222-3333-4444-555555555555",
			{ explicit: true },
		);
		expect(receipt.dirtySource).toBe(true);
		expect(receipt.executionWorkspace).toMatch(/packages[/\\]app$/);
		expect(
			await readFile(join(receipt.executionWorkspace, "tracked.txt"), "utf8"),
		).toBe("committed\n");
		await expect(
			readFile(join(receipt.executionWorkspace, "untracked.txt"), "utf8"),
		).rejects.toThrow();
	});

	it("removes only a clean worktree with no unique commits", async () => {
		const { workspace } = await repository();
		const receipt = await createManagedWorktree(
			workspace,
			"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			{ explicit: false },
		);
		await writeFile(join(receipt.executionWorkspace, "new.txt"), "retain\n");
		expect(
			await inspectManagedWorktreeCleanup(
				receipt.executionWorkspace,
				receipt.baseCommit,
			),
		).toMatchObject({ dirty: true, uniqueCommits: 0 });
		expect(await removeManagedWorktree(receipt)).toMatchObject({ dirty: true });
		await rm(join(receipt.executionWorkspace, "new.txt"));
		expect(await removeManagedWorktree(receipt)).toMatchObject({
			dirty: false,
			uniqueCommits: 0,
		});
		await expect(
			readFile(join(receipt.executionWorkspace, "tracked.txt")),
		).rejects.toThrow();
	});
});
