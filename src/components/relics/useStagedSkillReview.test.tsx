// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "#/test/utils";
import {
	type StagedAgentSkill,
	useStagedSkillReview,
} from "./useStagedSkillReview";

afterEach(cleanup);

const staged: StagedAgentSkill = {
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
		{ path: "references/a.md", bytes: 40, readable: true },
		{ path: "references/b.md", bytes: 50, readable: true },
	],
	fileCount: 3,
	bytes: 190,
	skillDocument: "# Review instructions",
};

function dependencies() {
	return {
		stageSkill: vi.fn().mockResolvedValue({ ok: true, skill: staged }),
		readStagedFile: vi.fn().mockResolvedValue({
			path: "references/a.md",
			content: "A",
		}),
		installSkill: vi.fn().mockResolvedValue({
			ok: true,
			installed: { id: staged.id, name: staged.name },
		}),
		discardSkill: vi.fn().mockResolvedValue({ ok: true }),
		onApproved: vi.fn(),
		onError: vi.fn(),
		onNotice: vi.fn(),
		onWarning: vi.fn(),
		onClose: vi.fn(),
	};
}

async function stageReview(result: {
	current: ReturnType<typeof useStagedSkillReview>;
}): Promise<void> {
	await act(async () => {
		await result.current.stageSource(staged.sourceUrl);
	});
}

describe("useStagedSkillReview", () => {
	it("keeps the selected filename paired with its content across out-of-order reads", async () => {
		const deps = dependencies();
		const readA = deferred<{ path: string; content: string }>();
		const readB = deferred<{ path: string; content: string }>();
		deps.readStagedFile.mockImplementation(({ data }) =>
			data.path === "references/a.md" ? readA.promise : readB.promise,
		);
		const { result } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		let selectA: Promise<void>;
		let selectB: Promise<void>;
		act(() => {
			selectA = result.current.selectFile("references/a.md");
			selectB = result.current.selectFile("references/b.md");
		});
		expect(result.current.selectedFile).toBe("references/b.md");
		expect(result.current.selectedContent).toBe("Loading…");

		await act(async () => {
			readB.resolve({ path: "references/b.md", content: "B content" });
			await selectB;
		});
		expect(result.current.selectedFile).toBe("references/b.md");
		expect(result.current.selectedContent).toBe("B content");

		await act(async () => {
			readA.resolve({ path: "references/a.md", content: "A content" });
			await selectA;
		});
		expect(result.current.selectedFile).toBe("references/b.md");
		expect(result.current.selectedContent).toBe("B content");
	});

	it("invalidates a pending read and discards the stage once when closing", async () => {
		const deps = dependencies();
		const read = deferred<{ path: string; content: string }>();
		const discard = deferred<{ ok: true }>();
		deps.readStagedFile.mockReturnValue(read.promise);
		deps.discardSkill.mockReturnValue(discard.promise);
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		let select: Promise<void>;
		act(() => {
			select = result.current.selectFile("references/a.md");
		});
		act(() => result.current.close());
		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
		expect(deps.onClose).not.toHaveBeenCalled();

		await act(async () => {
			read.resolve({ path: "references/a.md", content: "late content" });
			await select;
		});
		expect(result.current.selectedContent).toBe("Loading…");

		await act(async () => {
			discard.resolve({ ok: true });
			await Promise.resolve();
		});
		expect(deps.onClose).toHaveBeenCalledTimes(1);
		unmount();
		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
	});

	it("retires an approved stage without also discarding it", async () => {
		const deps = dependencies();
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		await act(async () => {
			await result.current.approve();
		});

		expect(deps.installSkill).toHaveBeenCalledWith({
			data: { id: staged.id },
		});
		expect(result.current.staged).toBeNull();
		expect(deps.onNotice).toHaveBeenLastCalledWith("review added to Hlid");
		expect(deps.onApproved).toHaveBeenCalledWith("review added to Hlid");
		unmount();
		expect(deps.discardSkill).not.toHaveBeenCalled();
	});

	it("surfaces a refresh warning separately from the committed install", async () => {
		const deps = dependencies();
		deps.installSkill.mockResolvedValueOnce({
			ok: true,
			installed: { id: staged.id, name: staged.name },
			warning: {
				code: "skill_snapshot_refresh_failed",
				message: "mounted vault unavailable",
			},
		});
		const { result } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		await act(async () => {
			await result.current.approve();
		});

		expect(deps.onNotice).toHaveBeenLastCalledWith("review added to Hlid");
		expect(deps.onWarning).toHaveBeenLastCalledWith(
			"Skill list refresh is delayed: mounted vault unavailable",
		);
		expect(deps.onApproved).toHaveBeenCalledWith("review added to Hlid");
		expect(deps.onError).not.toHaveBeenCalledWith(
			expect.stringContaining("mounted vault unavailable"),
		);
	});

	it("keeps an installed stage retired when the approval callback fails", async () => {
		const deps = dependencies();
		const callbackError = new Error("Managed inventory callback failed");
		deps.onApproved.mockRejectedValue(callbackError);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		await act(async () => {
			await result.current.approve();
		});

		expect(result.current.staged).toBeNull();
		expect(deps.discardSkill).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledWith(
			"Staged skill approval callback failed",
			callbackError,
		);
		unmount();
		expect(deps.discardSkill).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("keeps review actions busy until approval follow-up finishes", async () => {
		const deps = dependencies();
		const approvalFollowUp = deferred<void>();
		deps.onApproved.mockReturnValue(approvalFollowUp.promise);
		const { result } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		let approve = Promise.resolve();
		act(() => {
			approve = result.current.approve();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.busy).toBe(true);
		expect(result.current.staged).toBeNull();

		await act(async () => {
			expect(await result.current.stageSource("https://example.com/next")).toBe(
				"busy",
			);
		});
		expect(deps.stageSkill).toHaveBeenCalledTimes(1);

		await act(async () => {
			approvalFollowUp.resolve();
			await approve;
		});
		expect(result.current.busy).toBe(false);
	});

	it("waits for an in-flight approval before cleaning up after unmount", async () => {
		const deps = dependencies();
		const install = deferred<{
			ok: true;
			installed: { id: string; name: string };
		}>();
		deps.installSkill.mockReturnValue(install.promise);
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		let approve = Promise.resolve();
		act(() => {
			approve = result.current.approve();
		});
		unmount();
		expect(deps.discardSkill).not.toHaveBeenCalled();

		await act(async () => {
			install.reject(new Error("Install failed after close"));
			await approve;
		});
		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
		expect(deps.discardSkill).toHaveBeenCalledWith({
			data: { id: staged.id },
		});
	});

	it("discards a declined stage once and clears its review", async () => {
		const deps = dependencies();
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		await act(async () => {
			await result.current.decline();
		});

		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
		expect(deps.discardSkill).toHaveBeenCalledWith({
			data: { id: staged.id },
		});
		expect(result.current.staged).toBeNull();
		expect(deps.onNotice).toHaveBeenLastCalledWith("review declined");
		unmount();
		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
	});

	it("keeps a failed decline review open so cleanup can be retried", async () => {
		const deps = dependencies();
		deps.discardSkill
			.mockRejectedValueOnce(new Error("Cannot remove staged directory"))
			.mockResolvedValueOnce({ ok: true });
		const { result } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		await act(async () => {
			await result.current.decline();
		});
		expect(result.current.staged?.id).toBe(staged.id);
		expect(deps.onError).toHaveBeenLastCalledWith(
			"Cannot remove staged directory",
		);

		await act(async () => {
			await result.current.decline();
		});
		expect(deps.discardSkill).toHaveBeenCalledTimes(2);
		expect(result.current.staged).toBeNull();
	});

	it("closes after one failed discard without an unhandled duplicate cleanup", async () => {
		const deps = dependencies();
		const discard = deferred<{ ok: true }>();
		deps.discardSkill.mockReturnValue(discard.promise);
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));
		await stageReview(result);

		act(() => result.current.close());
		await act(async () => {
			discard.reject(new Error("Cannot remove staged directory"));
			await Promise.resolve();
		});
		expect(deps.onClose).toHaveBeenCalledTimes(1);
		unmount();
		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
	});

	it("discards a stage that finishes after unmount", async () => {
		const deps = dependencies();
		const stage = deferred<{ ok: true; skill: StagedAgentSkill }>();
		deps.stageSkill.mockReturnValue(stage.promise);
		const { result, unmount } = renderHook(() => useStagedSkillReview(deps));

		let request: Promise<unknown>;
		act(() => {
			request = result.current.stageSource(staged.sourceUrl);
		});
		unmount();
		await act(async () => {
			stage.resolve({ ok: true, skill: staged });
			await request;
		});

		expect(deps.discardSkill).toHaveBeenCalledTimes(1);
		expect(deps.discardSkill).toHaveBeenCalledWith({
			data: { id: staged.id },
		});
	});
});
