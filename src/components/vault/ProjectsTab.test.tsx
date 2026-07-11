// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ProjectNode } from "#/lib/vault";
import { ProjectNodeItem, ProjectsTab } from "./ProjectsTab";

afterEach(cleanup);

function project(overrides: Partial<Project> = {}): Project {
	return {
		file: "alpha.md",
		title: "Alpha",
		status: "active",
		rawStatus: "Doing",
		tags: ["work"],
		isFolder: false,
		content: "Project details",
		...overrides,
	};
}

describe("ProjectsTab", () => {
	it("renders its empty state", () => {
		render(<ProjectsTab initial={[]} emptyLabel="Nothing configured" />);
		expect(screen.getByText("Nothing configured")).not.toBeNull();
	});

	it("groups projects and expands markdown content", () => {
		render(
			<ProjectsTab
				initial={[
					project(),
					project({
						file: "done.md",
						title: "Done project",
						status: "done",
						rawStatus: "",
						tags: [],
					}),
				]}
			/>,
		);
		expect(screen.getByText("ACTIVE")).not.toBeNull();
		expect(screen.getByText("DONE")).not.toBeNull();
		expect(screen.getByText("work")).not.toBeNull();
		expect(screen.getByText("NO STATUS")).not.toBeNull();
		fireEvent.click(screen.getByText("Alpha"));
		expect(screen.getByText("Project details")).not.toBeNull();
	});

	it("expands a folder project into child nodes", () => {
		render(
			<ProjectsTab
				initial={[
					project({
						isFolder: true,
						content: undefined,
						children: [
							{
								name: "Child",
								path: "alpha/child.md",
								isFolder: false,
								content: "Child details",
							},
						],
					}),
				]}
			/>,
		);
		fireEvent.click(screen.getByText("Alpha"));
		expect(screen.getByText("Child")).not.toBeNull();
		fireEvent.click(screen.getByText("Child"));
		expect(screen.getByText("Child details")).not.toBeNull();
	});
});

describe("ProjectNodeItem", () => {
	it("renders nested folders and leaves empty nodes disabled", () => {
		const node: ProjectNode = {
			name: "Folder",
			path: "folder",
			isFolder: true,
			children: [{ name: "Empty", path: "folder/empty.md", isFolder: false }],
		};
		render(<ProjectNodeItem node={node} depth={1} />);
		fireEvent.click(screen.getByText("Folder"));
		const emptyButton = screen.getByText("Empty").closest("button");
		expect(emptyButton?.getAttribute("aria-disabled")).toBe("true");
		expect(emptyButton?.getAttribute("tabindex")).toBe("-1");
	});
});
