import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HlidConfig } from "#/config";
import {
	previewWorkspaceReference,
	resetWorkspaceReferenceIndexesForTesting,
	resolveWorkspaceReferences,
	searchWorkspaceReferences,
	selectWorkspaceReference,
} from "./workspaceReferences";

let root: string;
let workspace: string;
let vault: string;
let config: HlidConfig;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-workspace-refs-"));
	workspace = join(root, "workspace");
	vault = join(root, "vault");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(join(workspace, ".git"), { recursive: true });
	mkdirSync(join(workspace, ".claude"), { recursive: true });
	mkdirSync(join(workspace, "node_modules", "package"), { recursive: true });
	mkdirSync(join(workspace, "dist"), { recursive: true });
	mkdirSync(vault, { recursive: true });
	writeFileSync(join(workspace, "README.md"), "# Workspace");
	writeFileSync(join(workspace, "src", "app.ts"), "export const app = true;\n");
	writeFileSync(join(workspace, ".env"), "TOKEN=secret");
	writeFileSync(join(workspace, ".env.example"), "TOKEN=");
	writeFileSync(join(workspace, ".git", "config"), "private");
	writeFileSync(join(workspace, ".claude", "settings.json"), "{}");
	writeFileSync(join(workspace, "node_modules", "package", "index.js"), "dep");
	writeFileSync(join(workspace, "dist", "bundle.js"), "built");
	config = {
		vault: { path: vault, name: "Test" },
		agents: [{ path: workspace, name: "Workspace", mode: "cwd" }],
	} as HlidConfig;
	resetWorkspaceReferenceIndexesForTesting();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	resetWorkspaceReferenceIndexesForTesting();
});

describe("searchWorkspaceReferences", () => {
	it("indexes bounded source files while excluding internals and secrets", async () => {
		const result = await searchWorkspaceReferences({
			config,
			agentCwd: workspace,
		});
		expect(result.rootLabel).toBe("workspace");
		expect(result.items.map((item) => item.relativePath)).toEqual([
			".env.example",
			"README.md",
			"src/app.ts",
		]);
		expect(result.items.map((item) => item.relativePath)).not.toContain(".env");
		expect(result.items.map((item) => item.relativePath)).not.toContain(
			"dist/bundle.js",
		);
	});

	it("rejects a workspace not registered in Hlid", async () => {
		const other = join(root, "other");
		mkdirSync(other);
		await expect(
			searchWorkspaceReferences({ config, agentCwd: other }),
		).rejects.toThrow("not registered");
	});
});

describe("workspace preview and send-time resolution", () => {
	it("previews UTF-8 text and resolves only the same revision", async () => {
		const preview = await previewWorkspaceReference({
			config,
			agentCwd: workspace,
			relativePath: "src/app.ts",
		});
		expect(preview).toMatchObject({
			relativePath: "src/app.ts",
			content: "export const app = true;\n",
			truncated: false,
		});
		expect(preview.sha256).toMatch(/^[a-f0-9]{64}$/);
		const selection = await selectWorkspaceReference({
			config,
			agentCwd: workspace,
			relativePath: "src/app.ts",
		});
		expect(selection).toEqual({
			relativePath: "src/app.ts",
			name: "app.ts",
			directory: "src",
			sizeBytes: 25,
			sha256: preview.sha256,
			environment: expect.any(String),
			environmentLabel: expect.any(String),
			previewKind: "text",
			mime: "text/plain",
		});
		expect(selection).not.toHaveProperty("content");
		const readmePreview = await previewWorkspaceReference({
			config,
			agentCwd: workspace,
			relativePath: "README.md",
		});

		await expect(
			resolveWorkspaceReferences({
				allowedWorkspaceRoots: [vault, workspace],
				agentCwd: workspace,
				references: [
					{ relativePath: preview.relativePath, sha256: preview.sha256 },
					{
						relativePath: readmePreview.relativePath,
						sha256: readmePreview.sha256,
					},
				],
			}),
		).resolves.toEqual([
			expect.objectContaining({
				relativePath: "src/app.ts",
				path: join(workspace, "src", "app.ts"),
				sha256: preview.sha256,
			}),
			expect.objectContaining({
				relativePath: "README.md",
				path: join(workspace, "README.md"),
				sha256: readmePreview.sha256,
			}),
		]);

		writeFileSync(
			join(workspace, "src", "app.ts"),
			"export const app = false;\n",
		);
		await expect(
			resolveWorkspaceReferences({
				allowedWorkspaceRoots: [vault, workspace],
				agentCwd: workspace,
				references: [
					{ relativePath: preview.relativePath, sha256: preview.sha256 },
				],
			}),
		).rejects.toThrow("changed after selection");
	});

	it("previews and resolves supported raster images without treating them as text", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(join(workspace, "pixel.png"), png);
		const preview = await previewWorkspaceReference({
			config,
			agentCwd: workspace,
			relativePath: "pixel.png",
		});
		expect(preview).toMatchObject({
			previewKind: "image",
			mime: "image/png",
			sizeBytes: png.length,
			truncated: false,
		});
		if (preview.previewKind !== "image") throw new Error("expected image");
		expect(preview.dataUrl).toBe(
			`data:image/png;base64,${png.toString("base64")}`,
		);

		await expect(
			resolveWorkspaceReferences({
				allowedWorkspaceRoots: [vault, workspace],
				agentCwd: workspace,
				references: [
					{ relativePath: preview.relativePath, sha256: preview.sha256 },
				],
			}),
		).resolves.toEqual([
			expect.objectContaining({
				relativePath: "pixel.png",
				previewKind: "image",
				mime: "image/png",
				sha256: preview.sha256,
			}),
		]);
	});

	it("does not split a valid UTF-8 character at the text preview boundary", async () => {
		const prefix = "a".repeat(64 * 1024 - 1);
		writeFileSync(join(workspace, "unicode.txt"), `${prefix}🙂after`);

		const preview = await previewWorkspaceReference({
			config,
			agentCwd: workspace,
			relativePath: "unicode.txt",
		});

		expect(preview).toMatchObject({
			previewKind: "text",
			truncated: true,
		});
		if (preview.previewKind !== "text") throw new Error("expected text");
		expect(preview.content).toBe(prefix);
		expect(preview.content).not.toContain("�");
	});

	it("rejects binaries, known secrets, traversal, and escaping symlinks", async () => {
		writeFileSync(join(workspace, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(workspace, "linked.txt"));

		await expect(
			previewWorkspaceReference({
				config,
				agentCwd: workspace,
				relativePath: "binary.dat",
			}),
		).rejects.toThrow("Binary");
		await expect(
			previewWorkspaceReference({
				config,
				agentCwd: workspace,
				relativePath: ".env",
			}),
		).rejects.toThrow("cannot be referenced");
		await expect(
			previewWorkspaceReference({
				config,
				agentCwd: workspace,
				relativePath: "../outside.txt",
			}),
		).rejects.toThrow("cannot be referenced");
		await expect(
			previewWorkspaceReference({
				config,
				agentCwd: workspace,
				relativePath: "linked.txt",
			}),
		).rejects.toThrow("outside");
	});
});
