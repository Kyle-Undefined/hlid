import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteClaudeWorkflow,
	listClaudeWorkflows,
	readClaudeWorkflowSource,
	saveClaudeWorkflow,
} from "./claudeWorkflows";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hlid-claude-workflows-"));
	roots.push(root);
	return root;
}

function script(name: string, description = `Run ${name}`): string {
	return `export const meta = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  phases: [{ title: "Work" }],
}

return await agent("Do the work")
`;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Claude saved workflows", () => {
	it("discovers project and personal commands with native project precedence", async () => {
		const root = await tempRoot();
		const repo = join(root, "repo");
		const cwd = join(repo, "packages", "app");
		const configDir = join(root, "claude");
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(join(cwd, ".claude", "workflows"), { recursive: true }),
			mkdir(join(configDir, "workflows"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(
				join(cwd, ".claude", "workflows", "audit.js"),
				script("audit", "Project audit"),
			),
			writeFile(
				join(configDir, "workflows", "audit.js"),
				script("audit", "Personal audit"),
			),
			writeFile(
				join(configDir, "workflows", "research.js"),
				script("research"),
			),
		]);

		const catalog = await listClaudeWorkflows(cwd, configDir);

		expect(
			catalog.workflows.map(
				({ name, scope, availableAsCommand, description }) => ({
					name,
					scope,
					availableAsCommand,
					description,
				}),
			),
		).toEqual([
			{
				name: "audit",
				scope: "project",
				availableAsCommand: true,
				description: "Project audit",
			},
			{
				name: "audit",
				scope: "personal",
				availableAsCommand: false,
				description: "Personal audit",
			},
			{
				name: "research",
				scope: "personal",
				availableAsCommand: true,
				description: "Run research",
			},
		]);
		expect(catalog.locations).toEqual([
			expect.objectContaining({
				scope: "project",
				path: join(cwd, ".claude", "workflows"),
				available: true,
			}),
			expect.objectContaining({
				scope: "personal",
				path: join(configDir, "workflows"),
				available: true,
			}),
		]);
	});

	it("promotes only provider-persisted scripts and requires explicit replacement", async () => {
		const root = await tempRoot();
		const repo = join(root, "repo");
		const configDir = join(root, "claude");
		const source = join(
			configDir,
			"projects",
			"repo",
			"session",
			"workflows",
			"scripts",
			"route-audit.js",
		);
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(join(source, ".."), { recursive: true }),
		]);
		await writeFile(source, script("route-audit", "Audit every route"));

		const saved = await saveClaudeWorkflow(
			{
				cwd: repo,
				sourceScriptPath: source,
				scope: "project",
			},
			configDir,
		);

		expect(saved).toMatchObject({
			name: "route-audit",
			scope: "project",
			description: "Audit every route",
			availableAsCommand: true,
		});
		const target = join(repo, ".claude", "workflows", "route-audit.js");
		expect(await readFile(target, "utf8")).toBe(
			script("route-audit", "Audit every route"),
		);

		await expect(
			saveClaudeWorkflow(
				{
					cwd: repo,
					sourceScriptPath: source,
					scope: "project",
				},
				configDir,
			),
		).rejects.toMatchObject({
			code: "exists",
		});

		await writeFile(source, script("route-audit", "Updated audit"));
		await saveClaudeWorkflow(
			{
				cwd: repo,
				sourceScriptPath: source,
				scope: "project",
				overwrite: true,
			},
			configDir,
		);
		expect(await readFile(target, "utf8")).toBe(
			script("route-audit", "Updated audit"),
		);
	});

	it("rejects arbitrary sources and project workflow symlinks", async () => {
		const root = await tempRoot();
		const repo = join(root, "repo");
		const configDir = join(root, "claude");
		const outside = join(root, "outside.js");
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(join(configDir, "projects"), { recursive: true }),
			writeFile(outside, script("outside")),
		]);

		await expect(
			saveClaudeWorkflow(
				{
					cwd: repo,
					sourceScriptPath: outside,
					scope: "personal",
				},
				configDir,
			),
		).rejects.toMatchObject({
			code: "unsafe-path",
		});

		if (process.platform === "win32") return;
		const source = join(configDir, "projects", "saved.js");
		const redirected = join(root, "redirected");
		await Promise.all([
			writeFile(source, script("unsafe-save")),
			mkdir(join(repo, ".claude"), { recursive: true }),
			mkdir(redirected, { recursive: true }),
		]);
		await writeFile(join(redirected, "outside.js"), script("outside-link"));
		await symlink(redirected, join(repo, ".claude", "workflows"));

		const catalog = await listClaudeWorkflows(repo, configDir);
		expect(
			catalog.workflows.some((workflow) => workflow.name === "outside-link"),
		).toBe(false);
		expect(catalog.locations[0]).toMatchObject({
			scope: "project",
			available: false,
		});

		await expect(
			saveClaudeWorkflow(
				{
					cwd: repo,
					sourceScriptPath: source,
					scope: "project",
				},
				configDir,
			),
		).rejects.toMatchObject({
			code: "unsafe-path",
		});
	});

	it("deletes only an exact workflow from the current native catalog", async () => {
		const root = await tempRoot();
		const repo = join(root, "repo");
		const workflowDirectory = join(repo, ".claude", "workflows");
		const configDir = join(root, "claude");
		const target = join(workflowDirectory, "audit.js");
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(workflowDirectory, { recursive: true }),
			mkdir(join(configDir, "workflows"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(target, script("audit")),
			writeFile(
				join(configDir, "workflows", "personal-audit.js"),
				script("personal-audit"),
			),
		]);
		const catalog = await listClaudeWorkflows(repo, configDir);
		const workflow = catalog.workflows.find(
			(candidate) =>
				candidate.name === "audit" && candidate.scope === "project",
		);
		if (!workflow) throw new Error("Expected the project workflow");

		await deleteClaudeWorkflow(
			{
				cwd: repo,
				scriptPath: workflow.scriptPath,
				scope: "project",
			},
			configDir,
		);

		await expect(readFile(target, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(
			(await listClaudeWorkflows(repo, configDir)).workflows.map(
				(candidate) => candidate.name,
			),
		).toEqual(["personal-audit"]);
		await expect(
			deleteClaudeWorkflow(
				{
					cwd: repo,
					scriptPath: join(root, "outside.js"),
					scope: "project",
				},
				configDir,
			),
		).rejects.toMatchObject({ code: "not-found" });
		await expect(
			deleteClaudeWorkflow(
				{
					cwd: repo,
					scriptPath: join(configDir, "workflows", "personal-audit.js"),
					scope: "project",
				},
				configDir,
			),
		).rejects.toMatchObject({ code: "not-found" });
	});

	it("reads only persisted run scripts and exact saved catalog workflows", async () => {
		const root = await tempRoot();
		const repo = join(root, "repo");
		const configDir = join(root, "claude");
		const persisted = join(
			configDir,
			"projects",
			"repo",
			"session",
			"workflows",
			"scripts",
			"generated.js",
		);
		const savedDirectory = join(repo, ".claude", "workflows");
		const savedPath = join(savedDirectory, "saved-audit.js");
		const outside = join(root, "outside.js");
		await Promise.all([
			mkdir(join(repo, ".git"), { recursive: true }),
			mkdir(join(persisted, ".."), { recursive: true }),
			mkdir(savedDirectory, { recursive: true }),
		]);
		await Promise.all([
			writeFile(persisted, script("generated")),
			writeFile(savedPath, script("saved-audit")),
			writeFile(outside, script("outside")),
		]);

		expect(
			await readClaudeWorkflowSource(
				{ cwd: repo, scriptPath: persisted },
				configDir,
			),
		).toBe(script("generated"));

		const saved = (await listClaudeWorkflows(repo, configDir)).workflows.find(
			(workflow) => workflow.name === "saved-audit",
		);
		if (!saved) throw new Error("Expected a saved workflow");
		expect(
			await readClaudeWorkflowSource(
				{
					cwd: repo,
					scriptPath: saved.scriptPath,
					scope: saved.scope,
				},
				configDir,
			),
		).toBe(script("saved-audit"));

		await expect(
			readClaudeWorkflowSource({ cwd: repo, scriptPath: outside }, configDir),
		).rejects.toMatchObject({ code: "unsafe-path" });
		await expect(
			readClaudeWorkflowSource(
				{
					cwd: repo,
					scriptPath: saved.scriptPath,
					scope: "personal",
				},
				configDir,
			),
		).rejects.toMatchObject({ code: "not-found" });
	});
});
