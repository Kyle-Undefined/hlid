// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type CommandDescriptor, skillCommand } from "#/lib/commands";
import type { Skill } from "#/lib/skills";
import { useSlashPicker } from "./useSlashPicker";

afterEach(cleanup);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSkill(name: string, section = "vault"): Skill {
	return {
		file: `__test__/${name}`,
		name,
		description: `${name} description`,
		content: "",
		filePath: `/vault/${name}.md`,
		section,
	};
}

const SKILLS: CommandDescriptor[] = [
	makeSkill("help"),
	makeSkill("commit"),
	makeSkill("review"),
	makeSkill("compact", "claude"), // SDK skill — must appear in results
].map(skillCommand);

// ─── isOpen ──────────────────────────────────────────────────────────────────

describe("useSlashPicker – isOpen", () => {
	it("closed when prompt is empty", () => {
		const { result } = renderHook(() => useSlashPicker("", SKILLS, null));
		expect(result.current.isOpen).toBe(false);
	});

	it("closed when prompt doesn't start with /", () => {
		const { result } = renderHook(() => useSlashPicker("hello", SKILLS, null));
		expect(result.current.isOpen).toBe(false);
	});

	it("closed when prompt contains colon (skill already applied)", () => {
		const { result } = renderHook(() =>
			useSlashPicker("/help: context text", SKILLS, null),
		);
		expect(result.current.isOpen).toBe(false);
	});

	it("closed when prompt contains space after slash-query", () => {
		const { result } = renderHook(() =>
			useSlashPicker("/help foo", SKILLS, null),
		);
		expect(result.current.isOpen).toBe(false);
	});

	it("closed when activeSkill is set (user is typing context, not a new command)", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, SKILLS[0]));
		expect(result.current.isOpen).toBe(false);
	});

	it("closed when no skills match the query", () => {
		const { result } = renderHook(() => useSlashPicker("/zzz", SKILLS, null));
		expect(result.current.isOpen).toBe(false);
	});

	it("open when prompt is bare /", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		expect(result.current.isOpen).toBe(true);
	});

	it("open when prompt is a partial slash query", () => {
		const { result } = renderHook(() => useSlashPicker("/he", SKILLS, null));
		expect(result.current.isOpen).toBe(true);
	});
});

// ─── items ───────────────────────────────────────────────────────────────────

describe("useSlashPicker – items", () => {
	it("returns all skills when query is empty (/)", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		expect(result.current.items).toHaveLength(SKILLS.length);
	});

	it("filters by prefix match", () => {
		const { result } = renderHook(() => useSlashPicker("/co", SKILLS, null));
		const names = result.current.items.map((s) => s.name);
		expect(names).toContain("commit");
		expect(names).toContain("compact");
		expect(names).not.toContain("help");
		expect(names).not.toContain("review");
	});

	it("filter is case-insensitive", () => {
		const { result } = renderHook(() => useSlashPicker("/HE", SKILLS, null));
		const names = result.current.items.map((s) => s.name);
		expect(names).toContain("help");
	});

	it("includes SDK (claude-section) skills in results", () => {
		const { result } = renderHook(() => useSlashPicker("/comp", SKILLS, null));
		const names = result.current.items.map((s) => s.name);
		expect(names).toContain("compact");
	});

	it("returns empty items when nothing matches", () => {
		const { result } = renderHook(() => useSlashPicker("/zzz", SKILLS, null));
		expect(result.current.items).toHaveLength(0);
	});

	it("returns empty items when closed", () => {
		const { result } = renderHook(() => useSlashPicker("hello", SKILLS, null));
		expect(result.current.items).toHaveLength(0);
	});
});

// ─── selectedIndex ───────────────────────────────────────────────────────────

describe("useSlashPicker – selectedIndex", () => {
	it("starts at 0", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		expect(result.current.selectedIndex).toBe(0);
	});

	it("navigate(1) moves index down", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		act(() => result.current.navigate(1));
		expect(result.current.selectedIndex).toBe(1);
	});

	it("navigate(-1) moves index up", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		act(() => result.current.navigate(1));
		act(() => result.current.navigate(-1));
		expect(result.current.selectedIndex).toBe(0);
	});

	it("navigate(1) wraps around at end", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		for (let i = 0; i < SKILLS.length; i++) {
			act(() => result.current.navigate(1));
		}
		expect(result.current.selectedIndex).toBe(0);
	});

	it("navigate(-1) wraps around at start", () => {
		const { result } = renderHook(() => useSlashPicker("/", SKILLS, null));
		act(() => result.current.navigate(-1));
		expect(result.current.selectedIndex).toBe(SKILLS.length - 1);
	});

	it("resets to 0 when query changes", () => {
		const { result, rerender } = renderHook(
			({ prompt }: { prompt: string }) => useSlashPicker(prompt, SKILLS, null),
			{ initialProps: { prompt: "/co" } }, // matches commit + compact
		);
		act(() => result.current.navigate(1)); // idx → 1
		expect(result.current.selectedIndex).toBe(1);

		rerender({ prompt: "/h" }); // only help matches
		expect(result.current.selectedIndex).toBe(0);
	});

	it("clamps selectedIndex when items list shrinks without a query change", () => {
		const twoSkills = [makeSkill("commit"), makeSkill("compact")].map(
			skillCommand,
		);
		const { result, rerender } = renderHook(
			({ skills }: { skills: CommandDescriptor[] }) =>
				useSlashPicker("/co", skills, null),
			{ initialProps: { skills: twoSkills } },
		);
		act(() => result.current.navigate(1)); // idx → 1, 2 items
		expect(result.current.selectedIndex).toBe(1);

		// Skills list shrinks to 1 item — index must clamp to 0
		rerender({ skills: [skillCommand(makeSkill("commit"))] });
		expect(result.current.selectedIndex).toBe(0);
	});
});

// ─── close() ─────────────────────────────────────────────────────────────────

describe("useSlashPicker – close()", () => {
	it("close() forces isOpen to false without clearing the prompt", () => {
		const { result } = renderHook(() => useSlashPicker("/he", SKILLS, null));
		expect(result.current.isOpen).toBe(true);
		act(() => result.current.close());
		expect(result.current.isOpen).toBe(false);
		// items still populated — the prompt hasn't changed
		expect(result.current.items.length).toBeGreaterThan(0);
	});

	it("picker reopens after close() when the query changes", () => {
		const { result, rerender } = renderHook(
			({ prompt }: { prompt: string }) => useSlashPicker(prompt, SKILLS, null),
			{ initialProps: { prompt: "/he" } },
		);
		act(() => result.current.close());
		expect(result.current.isOpen).toBe(false);

		// User keeps typing — query changes → forceClosed resets → picker reopens
		rerender({ prompt: "/hel" });
		expect(result.current.isOpen).toBe(true);
	});

	it("close() when picker is already closed is a no-op", () => {
		const { result } = renderHook(() => useSlashPicker("hello", SKILLS, null));
		expect(result.current.isOpen).toBe(false);
		act(() => result.current.close());
		expect(result.current.isOpen).toBe(false);
	});
});
