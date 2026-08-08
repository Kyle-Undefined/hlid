// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	loaderData: {} as Record<string, unknown>,
	search: {} as { tab?: string },
	navigate: vi.fn(),
	enqueueChat: vi.fn(),
	uid: vi.fn(),
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
vi.mock("#/hooks/wsStore", () => ({
	enqueueChat: testState.enqueueChat,
}));
vi.mock("#/lib/utils", () => ({
	uid: testState.uid,
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
	testState.enqueueChat.mockReset();
	testState.uid
		.mockReset()
		.mockReturnValueOnce("new-session")
		.mockReturnValueOnce("new-turn");
	setLoaderData();
});

afterEach(cleanup);

describe("vault route", () => {
	it("defaults an unknown tab to the first configured vault category", () => {
		testState.search = { tab: "unknown" };
		renderVault();

		expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
		expect(
			screen.getByText(
				"notes:1::Inbox is empty. Add notes to the configured Inbox folder in Obsidian.",
			),
		).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: "INBOX1" })
				.getAttribute("aria-current"),
		).toBe("page");
	});

	it.each([
		["projects", "Projects", "projects:1::default"],
		[
			"wiki_folder",
			"Wiki",
			"projects:1::Wiki is empty. Add pages to the configured Wiki folder in Obsidian.",
		],
		["skills", "Skills", "skills:1:"],
		[
			"memory",
			"Memory",
			"notes:1::Nothing in memory yet. Saved memory notes will appear here.",
		],
		[
			"raw",
			"Raw",
			"notes:1::Raw is empty. Add unprocessed source notes to the configured Raw folder in Obsidian.",
		],
		[
			"areas",
			"Areas",
			"groups:1::No areas found. Add notes to the configured Areas folder in Obsidian.",
		],
		[
			"resources",
			"Resources",
			"groups:1::No resources found. Add reference notes to the configured Resources folder in Obsidian.",
		],
		[
			"archive",
			"Archive",
			"projects:1::Archive is empty. Finished or inactive notes moved there will appear here.",
		],
		[
			"outputs",
			"Outputs",
			"notes:1::No outputs yet. Generated documents saved to Outputs will appear here.",
		],
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
			screen.getByText(
				"notes:1:architecture:Nothing in memory yet. Saved memory notes will appear here.",
			),
		).toBeTruthy();

		fireEvent.change(screen.getByRole("combobox", { name: "Vault category" }), {
			target: { value: "projects" },
		});
		expect(testState.navigate).toHaveBeenCalledWith({
			search: { tab: "projects" },
		});
		expect(
			screen.getByText(
				"notes:1::Nothing in memory yet. Saved memory notes will appear here.",
			),
		).toBeTruthy();
	});

	it("queues a selected skill in an explicit Raven session", () => {
		testState.search = { tab: "skills" };
		renderVault();
		fireEvent.click(screen.getByRole("button", { name: "Run skill" }));

		expect(testState.enqueueChat).toHaveBeenCalledWith({
			id: "new-turn",
			text: "Run the release skill",
			session_id: "new-session",
		});
		expect(testState.navigate).toHaveBeenCalledWith({
			to: "/raven",
			search: { session: "new-session", agent: undefined },
		});
	});
});
