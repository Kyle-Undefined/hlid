// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "#/test/utils";
import { SkillManagerDialog } from "./SkillManagerDialog";

afterEach(cleanup);

const staged = {
	id: "d".repeat(24),
	name: "review",
	description: "Review a working tree",
	sourceUrl:
		"https://github.com/openai/skills/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/review",
	repository: "openai/skills",
	requestedRef: "main",
	resolvedSha: "a".repeat(40),
	repositoryPath: "skills/review",
	createdAt: "2026-07-21T00:00:00.000Z",
	files: [
		{ path: "SKILL.md", bytes: 100, readable: true },
		{ path: "references/checklist.md", bytes: 40, readable: true },
		{ path: "assets/logo.png", bytes: 80, readable: false },
	],
	fileCount: 3,
	bytes: 220,
	skillDocument: "---\nname: review\n---\n# Review instructions",
};

function dependencies() {
	return {
		listManaged: vi.fn().mockResolvedValue({
			skills: [
				{
					id: "c".repeat(24),
					name: "voice",
					description: "Use the configured voice",
					source: "Claude",
					sourceUrl: null,
					resolvedSha: null,
					importedAt: "2026-07-20T00:00:00.000Z",
					fileCount: 1,
					bytes: 100,
				},
			],
		}),
		discoverSkills: vi.fn().mockResolvedValue({
			ok: true,
			discovery: {
				repository: "openai/skills",
				requestedRef: "main",
				resolvedSha: "a".repeat(40),
				skills: [
					{
						name: "review",
						repositoryPath: "skills/review",
						sourceUrl: staged.sourceUrl,
						alreadyInstalled: false,
					},
				],
			},
		}),
		stageSkill: vi.fn().mockResolvedValue({ ok: true, skill: staged }),
		readStagedFile: vi.fn().mockResolvedValue({
			path: "references/checklist.md",
			content: "# Checklist\nRead every file.",
		}),
		installSkill: vi.fn().mockResolvedValue({
			ok: true,
			installed: { id: staged.id, name: "review" },
		}),
		discardSkill: vi.fn().mockResolvedValue({ ok: true }),
		readManagedSkill: vi.fn().mockResolvedValue({
			id: "c".repeat(24),
			name: "voice",
			content: "# Voice skill",
		}),
		removeSkill: vi.fn().mockResolvedValue({
			ok: true,
			removed: { id: "c".repeat(24), name: "voice" },
		}),
	};
}

describe("SkillManagerDialog", () => {
	it("dismisses from the backdrop without closing from dialog content", async () => {
		const onClose = vi.fn();
		render(<SkillManagerDialog onClose={onClose} {...dependencies()} />);
		const dialog = screen.getByRole("dialog", { name: "Agent skills" });

		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(dialog.parentElement as HTMLElement);
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it("stages a GitHub skill and exposes every readable file before approval", async () => {
		const deps = dependencies();
		deps.installSkill.mockResolvedValueOnce({
			ok: true,
			installed: { id: staged.id, name: "review" },
			warning: {
				code: "skill_snapshot_refresh_failed",
				message: "mounted vault unavailable",
			},
		});
		const onChanged = vi.fn();
		render(
			<SkillManagerDialog onClose={vi.fn()} onChanged={onChanged} {...deps} />,
		);

		expect(await screen.findByText("Use the configured voice")).toBeDefined();
		fireEvent.change(screen.getByLabelText("Skill source"), {
			target: {
				value: "https://github.com/openai/skills/tree/main/skills/review",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Find skills" }));

		expect(await screen.findByText("Review a working tree")).toBeDefined();
		expect(screen.getByText(/aaaaaaaaaaaa/)).toBeDefined();
		expect(screen.getByText("assets/logo.png")).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", { name: /references\/checklist.md/ }),
		);
		expect(await screen.findByText(/Read every file/)).toBeDefined();
		expect(deps.readStagedFile).toHaveBeenCalledWith({
			data: { id: staged.id, path: "references/checklist.md" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Add to Hlid" }));
		await waitFor(() =>
			expect(deps.installSkill).toHaveBeenCalledWith({
				data: { id: staged.id },
			}),
		);
		expect(onChanged).toHaveBeenCalledWith("review added to Hlid");
		expect(screen.getByText("review added to Hlid")).toBeDefined();
		expect(
			screen.getByText(
				"Skill list refresh is delayed: mounted vault unavailable",
			),
		).toBeDefined();
	});

	it("lists repository choices before staging a selected skill", async () => {
		const deps = dependencies();
		deps.discoverSkills.mockResolvedValueOnce({
			ok: true,
			discovery: {
				repository: "openai/skills",
				requestedRef: "main",
				resolvedSha: "a".repeat(40),
				skills: [
					{
						name: "review",
						repositoryPath: "skills/review",
						sourceUrl: staged.sourceUrl,
						alreadyInstalled: false,
					},
					{
						name: "testing",
						repositoryPath: "skills/testing",
						sourceUrl:
							"https://github.com/openai/skills/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/skills/testing",
						alreadyInstalled: false,
					},
				],
			},
		});
		render(<SkillManagerDialog onClose={vi.fn()} {...deps} />);
		await screen.findByText("Use the configured voice");
		fireEvent.change(screen.getByLabelText("Skill source"), {
			target: { value: "openai/skills" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Find skills" }));
		expect(await screen.findByText("skills/review")).toBeDefined();
		expect(screen.getByText("skills/testing")).toBeDefined();
		expect(deps.installSkill).not.toHaveBeenCalled();
		fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]);
		await screen.findByText("Review a working tree");
		expect(deps.stageSkill).toHaveBeenCalledWith({
			data: { sourceUrl: staged.sourceUrl },
		});
		expect(deps.installSkill).not.toHaveBeenCalled();
	});

	it("declines by deleting the staged copy", async () => {
		const deps = dependencies();
		render(<SkillManagerDialog onClose={vi.fn()} {...deps} />);
		await screen.findByText("Use the configured voice");
		fireEvent.change(screen.getByLabelText("Skill source"), {
			target: { value: staged.sourceUrl },
		});
		fireEvent.click(screen.getByRole("button", { name: "Find skills" }));
		await screen.findByText("Review a working tree");
		fireEvent.click(screen.getByRole("button", { name: "Decline" }));
		await waitFor(() =>
			expect(deps.discardSkill).toHaveBeenCalledWith({
				data: { id: staged.id },
			}),
		);
		expect(screen.getByText("review declined")).toBeDefined();
	});

	it("keeps a post-install inventory when the initial load finishes later", async () => {
		const deps = dependencies();
		const initialLoad =
			deferred<Awaited<ReturnType<typeof deps.listManaged>>>();
		const postInstallLoad =
			deferred<Awaited<ReturnType<typeof deps.listManaged>>>();
		deps.listManaged
			.mockReturnValueOnce(initialLoad.promise)
			.mockReturnValueOnce(postInstallLoad.promise);
		render(<SkillManagerDialog onClose={vi.fn()} {...deps} />);

		fireEvent.change(screen.getByLabelText("Skill source"), {
			target: { value: staged.sourceUrl },
		});
		fireEvent.click(screen.getByRole("button", { name: "Find skills" }));
		await screen.findByText("Review a working tree");
		fireEvent.click(screen.getByRole("button", { name: "Add to Hlid" }));
		await waitFor(() => expect(deps.listManaged).toHaveBeenCalledTimes(2));

		await act(async () => {
			postInstallLoad.resolve({
				skills: [
					{
						id: staged.id,
						name: "newly-installed",
						description: "Newest inventory",
						source: "Hlid",
						sourceUrl: staged.sourceUrl,
						resolvedSha: staged.resolvedSha,
						importedAt: staged.createdAt,
						fileCount: staged.fileCount,
						bytes: staged.bytes,
					},
				],
			});
			await postInstallLoad.promise;
		});
		expect(await screen.findByText("Newest inventory")).toBeDefined();

		await act(async () => {
			initialLoad.resolve({
				skills: [
					{
						id: "c".repeat(24),
						name: "stale",
						description: "Stale initial inventory",
						source: "Hlid",
						sourceUrl: null,
						resolvedSha: null,
						importedAt: null,
						fileCount: 1,
						bytes: 10,
					},
				],
			});
			await initialLoad.promise;
		});
		expect(screen.getByText("Newest inventory")).toBeDefined();
		expect(screen.queryByText("Stale initial inventory")).toBeNull();
	});
});
