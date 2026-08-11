// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageIntro } from "./PageHeader";
import { Section } from "./Section";
import { SectionRail } from "./SectionRail";

afterEach(cleanup);

describe("SectionRail", () => {
	const items = [
		{ id: "overview", label: "Overview" },
		{ id: "experience", label: "Experience" },
	];

	it("keeps the existing md breakpoint by default", () => {
		const onSelect = vi.fn();
		const { container } = render(
			<SectionRail
				items={items}
				activeId="overview"
				onSelect={onSelect}
				label="Settings categories"
			/>,
		);

		expect(container.querySelector("aside")?.className).toContain(
			"hidden md:flex",
		);
		fireEvent.click(screen.getByRole("button", { name: "Experience" }));
		expect(onSelect).toHaveBeenCalledWith("experience");
		expect(
			screen
				.getByRole("button", { name: "Overview" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("can stay collapsed until lg", () => {
		const { container } = render(
			<SectionRail
				items={items}
				activeId="overview"
				onSelect={() => undefined}
				label="Settings categories"
				visibleFrom="lg"
			/>,
		);

		expect(container.querySelector("aside")?.className).toContain(
			"hidden lg:flex",
		);
		expect(container.querySelector("aside")?.className).not.toContain(
			"md:flex",
		);
	});
});

describe("Section", () => {
	it("renders a programmatically focusable semantic heading anchor", () => {
		render(
			<Section title="Voice input" id="voice-input">
				<div>Controls</div>
			</Section>,
		);

		const heading = screen.getByRole("heading", {
			level: 2,
			name: "Voice input",
		});
		expect(heading.id).toBe("voice-input");
		expect(heading.tabIndex).toBe(-1);
		expect(heading.getAttribute("data-forge-setting-label")).toBe(
			"voice input",
		);
		expect(
			heading
				.closest("[data-forge-section]")
				?.getAttribute("data-forge-section"),
		).toBe("voice-input");
	});

	it("supports nested heading levels", () => {
		render(
			<Section title="Nested" headingLevel={3}>
				<div>Controls</div>
			</Section>,
		);

		expect(
			screen.getByRole("heading", { level: 3, name: "Nested" }),
		).not.toBeNull();
	});
});

describe("PageIntro", () => {
	it("supports a top-level focus target without changing the default level", () => {
		const { rerender } = render(<PageIntro title="Experience" />);
		expect(
			screen.getByRole("heading", { level: 2, name: "Experience" }),
		).not.toBeNull();

		rerender(<PageIntro title="Experience" id="experience" headingLevel={1} />);
		const heading = screen.getByRole("heading", {
			level: 1,
			name: "Experience",
		});
		expect(heading.id).toBe("experience");
		expect(heading.tabIndex).toBe(-1);
	});
});
