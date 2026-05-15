// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "#/lib/skills";
import { SlashPicker } from "./SlashPicker";

afterEach(cleanup);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSkill(name: string, description = "", section = "vault"): Skill {
	return {
		file: `__test__/${name}`,
		name,
		description,
		content: "",
		filePath: `/vault/${name}.md`,
		section,
	};
}

const ITEMS: Skill[] = [
	makeSkill("help", "Get help with commands"),
	makeSkill("commit", "Create a git commit"),
	makeSkill("compact", "Compact conversation", "claude"),
];

// ─── rendering ───────────────────────────────────────────────────────────────

describe("SlashPicker – rendering", () => {
	it("renders nothing when items list is empty", () => {
		const { container } = render(
			<SlashPicker items={[]} selectedIndex={0} onSelect={vi.fn()} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders a listbox with one option per skill", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		expect(screen.getByRole("listbox")).toBeDefined();
		expect(screen.getAllByRole("option")).toHaveLength(ITEMS.length);
	});

	it("renders skill descriptions when present", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		expect(screen.getByText("Get help with commands")).toBeDefined();
		expect(screen.getByText("Create a git commit")).toBeDefined();
	});

	it("does not crash when a skill has no description", () => {
		const noDesc = [makeSkill("bare", "")];
		expect(() =>
			render(
				<SlashPicker items={noDesc} selectedIndex={0} onSelect={vi.fn()} />,
			),
		).not.toThrow();
	});

	it("includes SDK (claude-section) skills", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		// At least one element with "compact" — name span and possibly description
		expect(screen.getAllByText(/compact/i).length).toBeGreaterThan(0);
	});
});

// ─── accessibility ────────────────────────────────────────────────────────────

describe("SlashPicker – accessibility", () => {
	it("each item has role=option", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(ITEMS.length);
	});

	it("selected item has aria-selected=true", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={1} onSelect={vi.fn()} />);
		const options = screen.getAllByRole("option");
		expect(options[1].getAttribute("aria-selected")).toBe("true");
	});

	it("non-selected items have aria-selected=false", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		const options = screen.getAllByRole("option");
		expect(options[1].getAttribute("aria-selected")).toBe("false");
		expect(options[2].getAttribute("aria-selected")).toBe("false");
	});

	it("listbox has accessible label", () => {
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={vi.fn()} />);
		expect(
			screen.getByRole("listbox", { name: /slash commands/i }),
		).toBeDefined();
	});
});

// ─── interaction ──────────────────────────────────────────────────────────────

describe("SlashPicker – interaction", () => {
	it("calls onSelect with the clicked skill", () => {
		const onSelect = vi.fn();
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={onSelect} />);
		const options = screen.getAllByRole("option");
		fireEvent.click(options[1]); // "commit"
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
	});

	it("calls onSelect with first item when index 0 clicked", () => {
		const onSelect = vi.fn();
		render(<SlashPicker items={ITEMS} selectedIndex={0} onSelect={onSelect} />);
		fireEvent.click(screen.getAllByRole("option")[0]);
		expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);
	});
});
