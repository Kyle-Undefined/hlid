// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_NAVIGATION_NAMES_CONFIG,
	NAVIGATION_LABEL_MAX_GRAPHEMES,
	NAVIGATION_NAME_DEFINITIONS,
	type NavigationNamesConfig,
} from "#/lib/navigationNames";
import { NavigationNamesSection } from "./NavigationNamesSection";

afterEach(cleanup);

function NavigationNamesHarness({
	initial,
	onChange,
}: {
	initial: NavigationNamesConfig;
	onChange?: (next: NavigationNamesConfig) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<NavigationNamesSection
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange?.(next);
			}}
		/>
	);
}

function presetButton(name: "Hlið" | "Plain language") {
	return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

describe("NavigationNamesSection", () => {
	it("selects Plain language by default and explains the display-only boundary", () => {
		render(
			<NavigationNamesHarness initial={DEFAULT_NAVIGATION_NAMES_CONFIG} />,
		);

		expect(
			screen.getByRole("heading", { name: "Navigation names" }),
		).toBeTruthy();
		expect(screen.getByText(/Routes and features do not change/)).toBeTruthy();
		expect(screen.getByText(/page terminology stays Hlið-native/)).toBeTruthy();
		expect(presetButton("Plain language").getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(presetButton("Hlið").getAttribute("aria-pressed")).toBe("false");

		for (const definition of NAVIGATION_NAME_DEFINITIONS) {
			const input = screen.getByLabelText(
				`${definition.hlidLabel} custom name`,
			) as HTMLInputElement;
			expect(input.value).toBe("");
			expect(input.placeholder).toBe(`Base: ${definition.plainLabel}`);
			expect(
				screen.getByTestId(`navigation-effective-${definition.id}`).textContent,
			).toBe(`Effective: ${definition.plainLabel}`);
		}
	});

	it("switches presets while preserving a newly entered custom name", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: {} }}
				onChange={onChange}
			/>,
		);
		const input = screen.getByLabelText(
			"EINHERJAR custom name",
		) as HTMLInputElement;

		fireEvent.change(input, { target: { value: "Workspace" } });
		fireEvent.blur(input);
		fireEvent.click(presetButton("Plain language"));

		expect(presetButton("Plain language").getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(input.value).toBe("Workspace");
		expect(
			screen.getByTestId("navigation-effective-einherjar").textContent,
		).toBe("Effective: Workspace");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "plain",
			labels: { einherjar: "Workspace" },
		});
	});

	it("does not emit a preset whose base collides with a custom name", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: { vault: "HOME" } }}
				onChange={onChange}
			/>,
		);

		fireEvent.click(presetButton("Plain language"));

		expect(presetButton("Hlið").getAttribute("aria-pressed")).toBe("true");
		expect(onChange).not.toHaveBeenCalled();
		expect(
			screen.getByText(/would use HOME for more than one menu item/),
		).toBeTruthy();
	});

	it("emits valid names while typing so navigation cannot discard them", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: {} }}
				onChange={onChange}
			/>,
		);

		fireEvent.change(screen.getByLabelText("RAVEN custom name"), {
			target: { value: "Conversations" },
		});

		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: { raven: "Conversations" },
		});
	});

	it("preserves and saves a duplicate draft when another edit resolves it", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: { watch: "Shared" } }}
				onChange={onChange}
			/>,
		);
		const vaultInput = screen.getByLabelText(
			"VAULT custom name",
		) as HTMLInputElement;

		fireEvent.change(vaultInput, { target: { value: "Shared" } });
		expect(vaultInput.getAttribute("aria-invalid")).toBe("true");
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText("WATCH custom name"), {
			target: { value: "Dashboard" },
		});

		expect(vaultInput.value).toBe("Shared");
		expect(vaultInput.getAttribute("aria-invalid")).toBeNull();
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: { watch: "Dashboard", vault: "Shared" },
		});
	});

	it("resets one custom name to its selected base", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "plain", labels: { einherjar: "Workspace" } }}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Use base name for EINHERJAR",
			}),
		);

		const input = screen.getByLabelText(
			"EINHERJAR custom name",
		) as HTMLInputElement;
		expect(input.value).toBe("");
		expect(input.placeholder).toBe("Base: AGENTS");
		expect(
			screen.getByTestId("navigation-effective-einherjar").textContent,
		).toBe("Effective: AGENTS");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "plain",
			labels: {},
		});
	});

	it("clears overrides without changing the preset, then restores all Hlið names", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{
					preset: "plain",
					labels: { watch: "Dashboard", raven: "Messages" },
				}}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear custom names" }));
		expect(presetButton("Plain language").getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(screen.getByTestId("navigation-effective-watch").textContent).toBe(
			"Effective: HOME",
		);
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "plain",
			labels: {},
		});

		fireEvent.click(screen.getByRole("button", { name: "Restore Hlið names" }));
		expect(presetButton("Hlið").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByTestId("navigation-effective-watch").textContent).toBe(
			"Effective: WATCH",
		);
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: {},
		});
	});

	it("previews effective names and keeps duplicate or overlong drafts local", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "plain", labels: { watch: "Dashboard" } }}
				onChange={onChange}
			/>,
		);
		expect(screen.getByTestId("navigation-effective-watch").textContent).toBe(
			"Effective: Dashboard",
		);
		expect(screen.getByTestId("navigation-effective-vault").textContent).toBe(
			"Effective: KNOWLEDGE",
		);

		const vaultInput = screen.getByLabelText(
			"VAULT custom name",
		) as HTMLInputElement;
		fireEvent.change(vaultInput, { target: { value: "dashboard" } });
		expect(vaultInput.getAttribute("aria-invalid")).toBe("true");
		expect(
			screen.getAllByText(/already used by another navigation item/).length,
		).toBeGreaterThanOrEqual(1);
		fireEvent.blur(vaultInput);
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.change(vaultInput, {
			target: { value: "x".repeat(NAVIGATION_LABEL_MAX_GRAPHEMES + 1) },
		});
		expect(screen.getByText(/25 of 24 characters/)).toBeTruthy();
		fireEvent.blur(vaultInput);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("rolls back a valid prefix when the completed name is invalid", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "plain", labels: {} }}
				onChange={onChange}
			/>,
		);
		const watchInput = screen.getByLabelText(
			"WATCH custom name",
		) as HTMLInputElement;

		for (const value of ["C", "CH", "CHA", "CHAT"]) {
			fireEvent.change(watchInput, { target: { value } });
		}

		expect(watchInput.value).toBe("CHAT");
		expect(watchInput.getAttribute("aria-invalid")).toBe("true");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "plain",
			labels: {},
		});
	});

	it("restores the focus-entry value when Escape cancels an edit", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: { raven: "Messages" } }}
				onChange={onChange}
			/>,
		);
		const input = screen.getByLabelText(
			"RAVEN custom name",
		) as HTMLInputElement;

		fireEvent.change(input, { target: { value: "Conversations" } });
		fireEvent.keyDown(input, { key: "Escape" });

		expect(input.value).toBe("Messages");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: { raven: "Messages" },
		});
	});

	it("ignores Escape on an untouched custom name", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: { raven: "Messages" } }}
				onChange={onChange}
			/>,
		);
		const input = screen.getByLabelText(
			"RAVEN custom name",
		) as HTMLInputElement;

		fireEvent.keyDown(input, { key: "Escape" });
		fireEvent.blur(input);

		expect(input.value).toBe("Messages");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: { raven: "Messages" },
		});
	});

	it("keeps a multi-field duplicate resolution valid when Escape follows", () => {
		const onChange = vi.fn();
		render(
			<NavigationNamesHarness
				initial={{ preset: "hlid", labels: { watch: "Shared" } }}
				onChange={onChange}
			/>,
		);
		const watchInput = screen.getByLabelText(
			"WATCH custom name",
		) as HTMLInputElement;

		fireEvent.change(screen.getByLabelText("VAULT custom name"), {
			target: { value: "Shared" },
		});
		fireEvent.change(watchInput, { target: { value: "Dashboard" } });
		fireEvent.keyDown(watchInput, { key: "Escape" });

		expect(watchInput.value).toBe("Dashboard");
		expect(onChange).toHaveBeenLastCalledWith({
			preset: "hlid",
			labels: { watch: "Dashboard", vault: "Shared" },
		});
	});
});
