// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNavigationLabels } from "#/lib/navigationNames";
import {
	NavigationNamesProvider,
	useNavigationLabels,
	usePublishNavigationNames,
} from "./NavigationNamesContext";

afterEach(cleanup);

function Probe() {
	const labels = useNavigationLabels();
	const publish = usePublishNavigationNames();
	return (
		<>
			<div data-testid="einherjar-label">{labels.einherjar}</div>
			<button
				type="button"
				onClick={() =>
					publish({ preset: "plain", labels: { einherjar: "Workspace" } })
				}
			>
				Publish
			</button>
		</>
	);
}

describe("NavigationNamesProvider", () => {
	it("publishes resolved labels throughout the mounted shell", () => {
		render(
			<NavigationNamesProvider initialLabels={resolveNavigationLabels()}>
				<Probe />
			</NavigationNamesProvider>,
		);

		expect(screen.getByTestId("einherjar-label").textContent).toBe("AGENTS");
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(screen.getByTestId("einherjar-label").textContent).toBe("Workspace");
	});

	it("does not replace a published label for an equivalent loader value", () => {
		const initialLabels = resolveNavigationLabels();
		const { rerender } = render(
			<NavigationNamesProvider initialLabels={initialLabels}>
				<Probe />
			</NavigationNamesProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		rerender(
			<NavigationNamesProvider initialLabels={{ ...initialLabels }}>
				<Probe />
			</NavigationNamesProvider>,
		);

		expect(screen.getByTestId("einherjar-label").textContent).toBe("Workspace");
	});
});
