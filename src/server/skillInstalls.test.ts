import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./libraryStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./libraryStore")>();
	const testRoot = () => process.env.HLID_TEST_SKILL_INSTALL_ROOT as string;
	return {
		...actual,
		managedSkillsDirectory: () => join(testRoot(), "managed"),
		skillStagingDirectory: () => join(testRoot(), "staging"),
		stagedSkillDirectory: (id: string) => join(testRoot(), "staging", id),
		prepareLibrary: async () => {
			mkdirSync(join(testRoot(), "managed"), { recursive: true });
			mkdirSync(join(testRoot(), "staging"), { recursive: true });
		},
	};
});

import { removeManagedSkill } from "./skillImports";
import {
	discardStagedSkill,
	discoverRemoteSkills,
	installStagedSkill,
	listManagedSkills,
	parseGitHubSkillUrl,
	readStagedSkillFile,
	stageGitHubSkill,
} from "./skillInstalls";

const SHA = "a".repeat(40);
const SKILL =
	"---\nname: demo\ndescription: Demonstrate staged skills\n---\n# Demo\nRead this first.\n";
let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-skill-install-"));
	process.env.HLID_TEST_SKILL_INSTALL_ROOT = root;
	fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/repos/openai/skills")) {
			return json({ default_branch: "main" });
		}
		if (url.includes("/commits/main")) return json({ sha: SHA });
		if (url.includes(`/commits/${SHA}`)) return json({ sha: SHA });
		if (url.includes(`/git/trees/${SHA}?recursive=1`)) {
			return json({
				truncated: false,
				tree: [
					{ type: "blob", mode: "100644", path: "README.md" },
					{ type: "blob", mode: "100644", path: "skills/demo/SKILL.md" },
					{ type: "blob", mode: "100755", path: "skills/demo/helper.md" },
					{ type: "blob", mode: "100644", path: "skills/other/SKILL.md" },
				],
			});
		}
		if (url.includes("/contents/skills/demo/SKILL.md?")) {
			return json({
				encoding: "base64",
				content: Buffer.from(SKILL).toString("base64"),
			});
		}
		if (url.includes("/contents/skills/demo/helper.md?")) {
			return json({
				encoding: "base64",
				content: Buffer.from("# Helper\nSupporting instructions.\n").toString(
					"base64",
				),
			});
		}
		if (url.includes("/contents/skills/demo?")) {
			return json([
				{
					type: "file",
					path: "skills/demo/SKILL.md",
					size: Buffer.byteLength(SKILL),
				},
				{ type: "file", path: "skills/demo/helper.md", size: 35 },
			]);
		}
		return json({ message: `Unexpected URL ${url}` }, 404);
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
	delete process.env.HLID_TEST_SKILL_INSTALL_ROOT;
});

describe("GitHub skill staging", () => {
	it("parses GitHub tree and SKILL.md blob URLs", () => {
		expect(
			parseGitHubSkillUrl(
				"https://github.com/openai/skills/tree/main/skills/demo",
			),
		).toEqual({
			owner: "openai",
			repo: "skills",
			ref: "main",
			path: "skills/demo",
		});
		expect(
			parseGitHubSkillUrl(
				"https://github.com/openai/skills/blob/main/skills/demo/SKILL.md",
			).path,
		).toBe("skills/demo");
		expect(() =>
			parseGitHubSkillUrl(
				"https://example.com/openai/skills/tree/main/skills/demo",
			),
		).toThrow("Only GitHub and skills.sh");
	});

	it("discovers repository sources and narrows skills.sh pages", async () => {
		const repository = await discoverRemoteSkills("openai/skills");
		expect(repository).toMatchObject({
			repository: "openai/skills",
			requestedRef: "main",
			resolvedSha: SHA,
		});
		expect(repository.skills.map((skill) => skill.repositoryPath)).toEqual([
			"skills/demo",
			"skills/other",
		]);

		const skillsSh = await discoverRemoteSkills(
			"https://skills.sh/openai/skills/demo",
		);
		expect(skillsSh.skills).toEqual([
			expect.objectContaining({
				name: "demo",
				repositoryPath: "skills/demo",
				sourceUrl: `https://github.com/openai/skills/tree/${SHA}/skills/demo`,
			}),
		]);
	});

	it("keeps downloaded files staged until explicit approval", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		expect(staged).toMatchObject({
			name: "demo",
			description: "Demonstrate staged skills",
			repository: "openai/skills",
			requestedRef: "main",
			resolvedSha: SHA,
			fileCount: 2,
		});
		expect(staged.files.map((file) => file.path)).toEqual([
			"helper.md",
			"SKILL.md",
		]);
		expect(existsSync(join(root, "managed", "demo"))).toBe(false);
		expect(await readStagedSkillFile(staged.id, "helper.md")).toEqual({
			path: "helper.md",
			content: "# Helper\nSupporting instructions.\n",
		});

		await installStagedSkill(staged.id);
		expect(
			readFileSync(join(root, "managed", "demo", "SKILL.md"), "utf8"),
		).toBe(SKILL);
		expect(
			statSync(join(root, "managed", "demo", "helper.md")).mode & 0o111,
		).toBe(0o100);
		expect(
			JSON.parse(
				readFileSync(
					join(root, "managed", "demo", ".hlid-source.json"),
					"utf8",
				),
			),
		).toMatchObject({
			source: "github",
			repository: "openai/skills",
			resolvedSha: SHA,
		});
		const [managed] = await listManagedSkills();
		expect(managed).toMatchObject({
			name: "demo",
			description: "Demonstrate staged skills",
			source: "GitHub",
			resolvedSha: SHA,
		});
		expect(await removeManagedSkill(managed.id)).toMatchObject({
			name: "demo",
		});
	});

	it("deletes a declined staged package", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		expect(await discardStagedSkill(staged.id)).toBe(true);
		expect(await discardStagedSkill(staged.id)).toBe(false);
		expect(existsSync(join(root, "managed", "demo"))).toBe(false);
	});
});
