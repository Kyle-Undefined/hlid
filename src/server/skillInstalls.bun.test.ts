// Bun lane: staged skill metadata is parsed by Bun.YAML.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "#/test/utils";

const skillImportMocks = vi.hoisted(() => ({
	validatePackageTree: vi.fn(),
}));

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

vi.mock("./skillImports", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./skillImports")>();
	skillImportMocks.validatePackageTree.mockImplementation(
		actual.validatePackageTree,
	);
	return {
		...actual,
		validatePackageTree: skillImportMocks.validatePackageTree,
	};
});

import { removeManagedSkill } from "./skillImports";
import {
	cleanupExpiredStages,
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

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => false,
			() => false,
		),
		new Promise<true>((resolvePending) =>
			setTimeout(() => resolvePending(true), 20),
		),
	]);
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
			stageId: staged.id,
			name: "demo",
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
		expect(await discardStagedSkill(staged.id)).toBe(true);
		expect(existsSync(join(root, "managed", "demo"))).toBe(false);
	});

	it("reconciles an install replay from its managed stage provenance", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		const installed = await installStagedSkill(staged.id);

		await expect(installStagedSkill(staged.id)).resolves.toEqual(installed);
		expect(existsSync(join(root, "staging", staged.id))).toBe(false);
		expect(existsSync(join(root, "managed", "demo"))).toBe(true);
	});

	it("reconciles legacy GitHub provenance that stored the stage as id", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		const installed = await installStagedSkill(staged.id);
		const provenancePath = join(root, "managed", "demo", ".hlid-source.json");
		const provenance = JSON.parse(
			readFileSync(provenancePath, "utf8"),
		) as Record<string, unknown>;
		delete provenance.stageId;
		delete provenance.name;
		provenance.id = staged.id;
		writeFileSync(
			provenancePath,
			`${JSON.stringify(provenance, null, 2)}\n`,
			"utf8",
		);

		await expect(installStagedSkill(staged.id)).resolves.toEqual(installed);
	});

	it("serializes competing install and discard actions truthfully", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		const validationEntered = deferred<void>();
		const releaseValidation = deferred<{ fileCount: number; bytes: number }>();
		skillImportMocks.validatePackageTree.mockImplementationOnce(() => {
			validationEntered.resolve();
			return releaseValidation.promise;
		});

		const installing = installStagedSkill(staged.id);
		await validationEntered.promise;
		const discarding = discardStagedSkill(staged.id);

		try {
			expect(await remainsPending(discarding)).toBe(true);
			expect(existsSync(join(root, "staging", staged.id))).toBe(true);
		} finally {
			releaseValidation.resolve({ fileCount: 2, bytes: 100 });
		}
		await expect(installing).resolves.toEqual({
			id: staged.id,
			name: "demo",
		});
		await expect(discarding).rejects.toThrow(
			"Skill demo was already added to Hlid",
		);
		expect(existsSync(join(root, "managed", "demo"))).toBe(true);
	});

	it("lets a claimed discard settle before a competing install", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);

		const discarding = discardStagedSkill(staged.id);
		const installing = installStagedSkill(staged.id);

		await expect(discarding).resolves.toBe(true);
		await expect(installing).rejects.toThrow(
			"Staged skill not found or expired",
		);
		expect(existsSync(join(root, "managed", "demo"))).toBe(false);
	});

	it("keeps TTL cleanup behind an active terminal settlement", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(join(root, "staging", staged.id), expired, expired);
		const validationEntered = deferred<void>();
		const releaseValidation = deferred<{ fileCount: number; bytes: number }>();
		skillImportMocks.validatePackageTree.mockImplementationOnce(() => {
			validationEntered.resolve();
			return releaseValidation.promise;
		});

		const installing = installStagedSkill(staged.id);
		await validationEntered.promise;
		const cleanup = cleanupExpiredStages();

		try {
			expect(await remainsPending(cleanup)).toBe(true);
			expect(existsSync(join(root, "staging", staged.id))).toBe(true);
		} finally {
			releaseValidation.resolve({ fileCount: 2, bytes: 100 });
		}
		await expect(installing).resolves.toEqual({
			id: staged.id,
			name: "demo",
		});
		await expect(cleanup).resolves.toBeUndefined();
		expect(existsSync(join(root, "managed", "demo"))).toBe(true);
	});

	it("keeps an installed skill's name tied to its managed directory", async () => {
		const staged = await stageGitHubSkill(
			"https://github.com/openai/skills/tree/main/skills/demo",
		);
		await installStagedSkill(staged.id);
		writeFileSync(
			join(root, "managed", "demo", "SKILL.md"),
			"---\nname: Renamed in frontmatter\ndescription: Updated description\n---\n",
		);

		expect(await listManagedSkills()).toEqual([
			expect.objectContaining({
				name: "demo",
				description: "Updated description",
			}),
		]);
	});
});
