// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: {} as { tab?: string },
	navigate: vi.fn(),
	send: vi.fn(),
	setPendingPrompt: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useLoaderData: () => testState.loaderData,
		useSearch: () => testState.search,
	}),
	useNavigate: () => testState.navigate,
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({ handler: () => vi.fn() }),
}));

vi.mock("#/components/vault/NotesTab", () => ({
	NotesTab: ({
		notes,
		query,
		emptyLabel,
	}: {
		notes: unknown[];
		query: string;
		emptyLabel: string;
	}) => <div>{`notes:${notes.length}:${query}:${emptyLabel}`}</div>,
	FolderGroupsTab: ({
		groups,
		query,
		emptyLabel,
	}: {
		groups: unknown[];
		query: string;
		emptyLabel: string;
	}) => <div>{`groups:${groups.length}:${query}:${emptyLabel}`}</div>,
}));
vi.mock("#/components/vault/ProjectsTab", () => ({
	ProjectsTab: ({
		initial,
		query,
		emptyLabel,
	}: {
		initial: unknown[];
		query: string;
		emptyLabel?: string;
	}) => (
		<div>{`projects:${initial.length}:${query}:${emptyLabel ?? "default"}`}</div>
	),
}));
vi.mock("#/components/vault/SkillsTab", () => ({
	SkillsTab: ({
		skills,
		query,
		onRun,
	}: {
		skills: unknown[];
		query: string;
		onRun: (content: string) => void;
	}) => (
		<div>
			{`skills:${skills.length}:${query}`}
			<button type="button" onClick={() => onRun("Run the release skill")}>
				Run skill
			</button>
		</div>
	),
}));
vi.mock("#/hooks/useWs", () => ({
	useWs: () => ({ send: testState.send }),
}));
vi.mock("#/hooks/wsChatQueueStore", () => ({
	setPendingPrompt: testState.setPendingPrompt,
}));

import { Route } from "./vault";

const TAB_CONFIG = [
	["inbox", "INBOX"],
	["projects", "PROJECTS"],
	["areas", "AREAS"],
	["resources", "RESOURCES"],
	["archive", "ARCHIVE"],
	["raw", "RAW"],
	["wiki_folder", "WIKI"],
	["skills", "SKILLS"],
	["memory", "MEMORY"],
	["outputs", "OUTPUTS"],
].map(([id, label]) => ({ id, label }));

function setLoaderData(): void {
	testState.loaderData = {
		tabConfig: TAB_CONFIG,
		projects: [{ id: "project" }],
		wikiPages: [{ id: "wiki" }],
		resources: [{ children: [{ id: "resource" }] }],
		archive: [{ id: "archive" }],
		skills: [{ id: "skill" }],
		sectionOrder: ["release"],
		memory: [{ id: "memory" }],
		inbox: [{ id: "inbox" }],
		raw: [{ id: "raw" }],
		areas: [{ children: [{ id: "area-1" }, { id: "area-2" }] }],
		outputs: [{ id: "output" }],
	};
}

function renderVault(): ReturnType<typeof render> {
	const Component = (Route as unknown as { component: ComponentType })
		.component;
	return render(<Component />);
}

beforeEach(() => {
	testState.search = {};
	testState.navigate.mockReset();
	testState.send.mockReset();
	testState.setPendingPrompt.mockReset();
	setLoaderData();
});

afterEach(cleanup);

describe("vault route", () => {
	it("defaults an unknown tab to the first configured vault category", () => {
		testState.search = { tab: "unknown" };
		renderVault();

		expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
		expect(screen.getByText("notes:1::inbox is empty")).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "INBOX1" })
				.getAttribute("aria-current"),
		).toBe("page");
	});

	it.each([
		["projects", "Projects", "projects:1::default"],
		["wiki_folder", "Wiki", "projects:1::wiki is empty"],
		["skills", "Skills", "skills:1:"],
		["memory", "Memory", "notes:1::nothing in memory yet"],
		["raw", "Raw", "notes:1::raw folder is empty"],
		["areas", "Areas", "groups:1::no areas found"],
		["resources", "Resources", "groups:1::no resources found"],
		["archive", "Archive", "projects:1::archive is empty"],
		["outputs", "Outputs", "notes:1::no outputs yet"],
	])("renders the %s tab with its configured data", (tab, heading, content) => {
		testState.search = { tab };
		renderVault();

		expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
		expect(screen.getByText(content)).toBeTruthy();
	});

	it("clears the current search before navigating to another category", () => {
		testState.search = { tab: "memory" };
		renderVault();
		fireEvent.change(screen.getByRole("textbox", { name: "Search vault" }), {
			target: { value: "architecture" },
		});
		expect(
			screen.getByText("notes:1:architecture:nothing in memory yet"),
		).toBeTruthy();

		fireEvent.change(screen.getByRole("combobox", { name: "Vault category" }), {
			target: { value: "projects" },
		});
		expect(testState.navigate).toHaveBeenCalledWith({
			search: { tab: "projects" },
		});
		expect(screen.getByText("notes:1::nothing in memory yet")).toBeTruthy();
	});

	it("starts a selected skill in Raven with the same queued and sent prompt", () => {
		testState.search = { tab: "skills" };
		renderVault();
		fireEvent.click(screen.getByRole("button", { name: "Run skill" }));

		expect(testState.setPendingPrompt).toHaveBeenCalledWith(
			"Run the release skill",
		);
		expect(testState.send).toHaveBeenCalledWith({
			type: "chat",
			text: "Run the release skill",
		});
		expect(testState.navigate).toHaveBeenCalledWith({
			to: "/raven",
			search: { session: undefined, agent: undefined },
		});
	});
});
