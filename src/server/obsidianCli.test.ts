import { describe, expect, it, vi } from "vitest";
import {
	appendToObsidian,
	createObsidianBaseItem,
	createObsidianNote,
	executeObsidianCommand,
	getActiveObsidianNote,
	getObsidianCliStatus,
	listObsidianCommands,
	listObsidianTemplates,
	MAX_OBSIDIAN_APPEND_CHARS,
	moveObsidianFile,
	mutateObsidianNote,
	obsidianReferenceItem,
	openObsidianDailyNote,
	openObsidianNote,
	patchObsidianNoteText,
	queryObsidianBase,
	queryObsidianCurrentNote,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianSearch,
	queryObsidianTasks,
	queryObsidianVaultInfo,
	readObsidianDailyNote,
	readObsidianNote,
	readObsidianTemplate,
	removeObsidianProperty,
	renameObsidianFile,
	replaceObsidianNoteText,
	setObsidianProperty,
	testObsidianConnection,
	trashObsidianFile,
	updateObsidianTask,
} from "./obsidianCli";

const windowsDetection = JSON.stringify({
	executable:
		"C:\\Users\\kyle\\AppData\\Local\\Programs\\Obsidian\\Obsidian.com",
	registered: false,
	version: "1.12.7",
});

function wslDependencies(
	outputs: Array<{ output: string; code: number | null }>,
) {
	const run = vi.fn(
		async (
			_executable: string,
			_args: string[],
			_options: {
				timeoutMs: number;
				timeoutError: string;
				maxOutputChars?: number;
			},
		) => outputs.shift() ?? { output: "", code: 0 },
	);
	return {
		dependencies: {
			platform: "linux" as const,
			env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
			exists: (path: string) => path.endsWith("/Obsidian/Obsidian.com"),
			run,
		},
		run,
	};
}

describe("Obsidian CLI bridge", () => {
	it("passively detects the Windows CLI from WSL without launching Obsidian", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
		]);

		await expect(getObsidianCliStatus(dependencies)).resolves.toEqual({
			supported: true,
			installed: true,
			registered: false,
			version: "1.12.7",
			state: "available",
			detail:
				"Obsidian CLI is installed. Enable it in Obsidian settings if connection fails.",
		});
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]?.[0]).toBe("powershell.exe");
	});

	it("reports a missing Windows installation without failing Forge", async () => {
		const { dependencies } = wslDependencies([
			{
				output: JSON.stringify({
					executable: null,
					registered: false,
					version: null,
				}),
				code: 0,
			},
		]);
		dependencies.exists = () => false;

		const status = await getObsidianCliStatus(dependencies);
		expect(status.state).toBe("not_installed");
		expect(status.installed).toBe(false);
	});

	it("treats Obsidian's zero-exit missing-vault response as an error", async () => {
		const { dependencies } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Vault not found.", code: 0 },
		]);

		await expect(
			queryObsidianLinks("Missing", { kind: "unresolved" }, dependencies),
		).rejects.toThrow("Vault not found");
	});

	it("detects a registered native Unix CLI from PATH", async () => {
		const status = await getObsidianCliStatus({
			platform: "darwin",
			env: { PATH: "/usr/local/bin:/usr/bin" },
			exists: (path) => path === "/usr/local/bin/obsidian",
		});
		expect(status).toMatchObject({
			state: "available",
			installed: true,
			registered: true,
		});
	});

	it("reads the active note path from the configured vault", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{
				output:
					"path\tNotes\\Current note.md\r\nname\tCurrent note\r\nextension\tmd",
				code: 0,
			},
		]);

		await expect(getActiveObsidianNote("Fornbok", dependencies)).resolves.toBe(
			"Notes/Current note.md",
		);
		expect(run.mock.calls[1]?.[0]).toBe(
			"/mnt/c/Users/kyle/AppData/Local/Programs/Obsidian/Obsidian.com",
		);
		expect(run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "file"]);
	});

	it("opens an exact vault-relative note using argument-safe invocation", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);

		await openObsidianNote("My Vault", "Projects/One thing.md", dependencies);
		expect(run.mock.calls[1]?.[1]).toEqual([
			"vault=My Vault",
			"open",
			"path=Projects/One thing.md",
		]);
	});

	it("moves and renames files through Obsidian so links stay correct", async () => {
		const move = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Moved", code: 0 },
		]);
		await expect(
			moveObsidianFile(
				"Fornbok",
				{ path: "Notes/Old.md", to: "Archive/Old.md" },
				move.dependencies,
			),
		).resolves.toEqual({ path: "Archive/Old.md" });
		expect(move.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"move",
			"path=Notes/Old.md",
			"to=Archive/Old.md",
		]);

		const rename = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Renamed", code: 0 },
		]);
		await expect(
			renameObsidianFile(
				"Fornbok",
				{ path: "Notes/Old.md", name: "New.md" },
				rename.dependencies,
			),
		).resolves.toEqual({ path: "Notes/New.md" });
		expect(rename.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"rename",
			"path=Notes/Old.md",
			"name=New.md",
		]);
	});

	it("uses separate safe commands for active and daily appends", async () => {
		const active = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await appendToObsidian(
			"Fornbok",
			"active",
			"  Saved answer  ",
			active.dependencies,
		);
		expect(active.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"append",
			"content=Saved answer",
		]);

		const daily = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await appendToObsidian(
			"Fornbok",
			"daily",
			"Saved answer",
			daily.dependencies,
		);
		expect(daily.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"daily:append",
			"content=Saved answer",
		]);
	});

	it("rejects oversized appends before starting Obsidian", async () => {
		const { dependencies, run } = wslDependencies([]);
		await expect(
			appendToObsidian(
				"Fornbok",
				"daily",
				"x".repeat(MAX_OBSIDIAN_APPEND_CHARS + 1),
				dependencies,
			),
		).rejects.toThrow("limited");
		expect(run).not.toHaveBeenCalled();
	});

	it("lists and reads templates through curated CLI commands", async () => {
		const list = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "New Note\nNew Project", code: 0 },
		]);
		await expect(
			listObsidianTemplates("Fornbok", false, list.dependencies),
		).resolves.toBe("New Note\nNew Project");
		expect(list.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "templates"]);

		const read = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "# Project", code: 0 },
		]);
		await readObsidianTemplate(
			"Fornbok",
			{ name: "New Project", resolve: true, title: "Hlid" },
			read.dependencies,
		);
		expect(read.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"template:read",
			"name=New Project",
			"resolve",
			"title=Hlid",
		]);
	});

	it("lists commands and executes one exact command ID", async () => {
		const list = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "templater-obsidian:insert-templater", code: 0 },
		]);
		await expect(
			listObsidianCommands("Fornbok", list.dependencies),
		).resolves.toBe("templater-obsidian:insert-templater");
		expect(list.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "commands"]);

		const execute = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Executed", code: 0 },
		]);
		await executeObsidianCommand(
			"Fornbok",
			"templater-obsidian:insert-templater",
			execute.dependencies,
		);
		expect(execute.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"command",
			"id=templater-obsidian:insert-templater",
		]);
	});

	it("creates core-template notes without permitting overwrite", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "# {{title}}", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
		]);

		await expect(
			createObsidianNote(
				"Fornbok",
				{
					path: "0 Inbox/One.md",
					template: "New Note",
					content: "Body",
					open: true,
				},
				dependencies,
			),
		).resolves.toEqual({ path: "0 Inbox/One.md" });
		expect(run.mock.calls[3]?.[1]).toEqual([
			"vault=Fornbok",
			"create",
			"path=0 Inbox/One.md",
			"template=New Note",
			"content=Body",
			"open",
		]);
		expect(run.mock.calls[3]?.[1]).not.toContain("overwrite");
	});

	it("chunks long direct note content without splitting Unicode", async () => {
		const body = "😀".repeat(1_500);
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
		]);

		await expect(
			createObsidianNote(
				"Fornbok",
				{ path: "0 Inbox/Long.md", content: body },
				dependencies,
			),
		).resolves.toEqual({ path: "0 Inbox/Long.md" });
		expect(run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"create",
			"path=0 Inbox/Long.md",
		]);
		const chunks = [3, 5].map((index) =>
			run.mock.calls[index]?.[1]?.[3]?.replace(/^content=/, ""),
		);
		expect(chunks.join("")).toBe(body);
		expect(Buffer.byteLength(chunks[0] ?? "", "utf8")).toBe(4_000);
		for (const index of [3, 5]) {
			expect(
				Buffer.byteLength(run.mock.calls[index]?.[1]?.[3] ?? "", "utf8"),
			).toBeLessThan(4_096);
			expect(run.mock.calls[index]?.[1]?.[4]).toBe("inline");
		}
	});

	it("keeps note content out of Templater eval and appends to the routed path", async () => {
		const privateBody = "Private body".repeat(1_000);
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "# <% tp.file.title %>", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: '=> {"path":"1 Projects/One.md"}', code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
		]);

		await expect(
			createObsidianNote(
				"Fornbok",
				{
					path: "0 Inbox/One.md",
					template: "New Project",
					content: privateBody,
				},
				dependencies,
			),
		).resolves.toEqual({ path: "1 Projects/One.md" });
		const args = run.mock.calls[3]?.[1] ?? [];
		expect(args.slice(0, 2)).toEqual(["vault=Fornbok", "eval"]);
		expect(args[2]).toContain("create_new_note_from_template");
		expect(args[2]?.length).toBeLessThan(2_000);
		const encodedPayload = args[2]?.match(/atob\("([^"]+)"\)/)?.[1];
		expect(encodedPayload).toBeTruthy();
		expect(
			JSON.parse(Buffer.from(encodedPayload ?? "", "base64").toString("utf8")),
		).toEqual({
			path: "0 Inbox/One.md",
			template: "New Project",
			open: false,
		});
		const appendCalls = [5, 7, 9].map((index) => run.mock.calls[index]?.[1]);
		expect(
			appendCalls.map((args) => args?.[3]?.replace(/^content=/, "")).join(""),
		).toBe(privateBody);
		for (const args of appendCalls) {
			expect(args?.slice(0, 3)).toEqual([
				"vault=Fornbok",
				"append",
				"path=1 Projects/One.md",
			]);
			expect(Buffer.byteLength(args?.[3] ?? "", "utf8")).toBeLessThan(4_096);
			expect(args?.[4]).toBe("inline");
		}
	});

	it("rejects interactive Templater templates before creating a file", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: '<% await tp.system.prompt("Folder") %>', code: 0 },
		]);

		await expect(
			createObsidianNote(
				"Fornbok",
				{ path: "Notes/One.md", template: "Interactive" },
				dependencies,
			),
		).rejects.toThrow("requires interactive Templater input");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("appends and prepends through Obsidian and reports the updated path", async () => {
		const exact = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await expect(
			mutateObsidianNote(
				"Fornbok",
				"prepend",
				{
					target: "path",
					path: "Notes/One.md",
					content: "Heading",
				},
				exact.dependencies,
			),
		).resolves.toEqual({ path: "Notes/One.md" });
		expect(exact.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"prepend",
			"path=Notes/One.md",
			"content=Heading",
		]);

		const daily = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "0 Inbox/2026-07-20.md", code: 0 },
		]);
		await expect(
			mutateObsidianNote(
				"Fornbok",
				"append",
				{ target: "daily", content: "Done" },
				daily.dependencies,
			),
		).resolves.toEqual({ path: "0 Inbox/2026-07-20.md" });
		expect(daily.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"daily:append",
			"content=Done",
		]);
	});

	it("replaces one exact note block through an atomic Obsidian process", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output: '=> {"path":"Notes/One.md","replacements":1,"changed":true}',
				code: 0,
			},
		]);

		await expect(
			replaceObsidianNoteText(
				"Fornbok",
				{
					path: "Notes/One.md",
					oldText: "Before",
					newText: "After",
				},
				dependencies,
			),
		).resolves.toEqual({ path: "Notes/One.md", replacements: 1 });

		const createArgs = run.mock.calls[1]?.[1] ?? [];
		expect(createArgs.slice(0, 2)).toEqual(["vault=Fornbok", "create"]);
		expect(createArgs[2]).toMatch(/^path=Hlid edit payload [0-9a-f-]+\.md$/);
		expect(createArgs[3]).toBe(
			'content={"replacements":[{"oldText":"Before","newText":"After"}]}',
		);

		const evalArgs = run.mock.calls[3]?.[1] ?? [];
		expect(evalArgs.slice(0, 2)).toEqual(["vault=Fornbok", "eval"]);
		const code = evalArgs[2]?.replace(/^code=/, "") ?? "";
		expect(code).toContain("app.vault.process");
		expect(code).toContain("next.indexOf(replacement.oldText,first+1)");
		expect(code).toContain("app.vault.delete(payloadFile)");
		expect(code).not.toContain("Before");
		expect(code).not.toContain("After");
	});

	it("keeps chunked edit payload creation, append, and eval on one Markdown path", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Appended", code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output: '=> {"path":"Notes/One.md","replacements":1,"changed":true}',
				code: 0,
			},
		]);
		const oldText = "x".repeat(4_100);

		await expect(
			replaceObsidianNoteText(
				"Fornbok",
				{
					path: "Notes/One.md",
					oldText,
					newText: "After",
				},
				dependencies,
			),
		).resolves.toEqual({ path: "Notes/One.md", replacements: 1 });

		const createArgs = run.mock.calls[1]?.[1] ?? [];
		const payloadArgument = createArgs[2];
		expect(payloadArgument).toMatch(/^path=Hlid edit payload [0-9a-f-]+\.md$/);
		expect(createArgs).toHaveLength(3);
		expect(run.mock.calls[3]?.[1]?.[2]).toBe(payloadArgument);
		expect(run.mock.calls[5]?.[1]?.[2]).toBe(payloadArgument);
		expect(run.mock.calls[3]?.[1]?.at(-1)).toBe("inline");
		expect(run.mock.calls[5]?.[1]?.at(-1)).toBe("inline");
		expect(run.mock.calls[7]?.[1]?.slice(0, 2)).toEqual([
			"vault=Fornbok",
			"eval",
		]);
	});

	it("cleans up a staged edit payload when exact replacement fails", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output: "Error: Expected text occurs more than once in Notes/One.md",
				code: 0,
			},
			{ output: windowsDetection, code: 0 },
			{ output: "Deleted", code: 0 },
		]);

		await expect(
			replaceObsidianNoteText(
				"Fornbok",
				{
					path: "Notes/One.md",
					oldText: "Repeated",
					newText: "Once",
				},
				dependencies,
			),
		).rejects.toThrow("occurs more than once");

		const payloadPath = run.mock.calls[1]?.[1]?.[2];
		expect(payloadPath).toMatch(/^path=Hlid edit payload [0-9a-f-]+\.md$/);
		expect(run.mock.calls[5]?.[1]).toEqual([
			"vault=Fornbok",
			"delete",
			payloadPath,
			"permanent",
		]);
	});

	it("applies multiple exact replacements as one atomic note patch", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Created", code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output: '=> {"path":"Notes/One.md","replacements":2,"changed":true}',
				code: 0,
			},
		]);

		await expect(
			patchObsidianNoteText(
				"Fornbok",
				{
					path: "Notes/One.md",
					replacements: [
						{ oldText: "One", newText: "First" },
						{ oldText: "Two", newText: "Second" },
					],
				},
				dependencies,
			),
		).resolves.toEqual({ path: "Notes/One.md", replacements: 2 });

		expect(run.mock.calls[1]?.[1]?.[3]).toBe(
			'content={"replacements":[{"oldText":"One","newText":"First"},{"oldText":"Two","newText":"Second"}]}',
		);
		const code = run.mock.calls[3]?.[1]?.[2] ?? "";
		expect(code).toContain(
			"for(let index=0;index<payload.replacements.length;index++)",
		);
		expect(code).toContain("Replacement ");
	});

	it("trashes one exact file without exposing permanent deletion", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Deleted", code: 0 },
		]);

		await expect(
			trashObsidianFile("Fornbok", { path: "Notes/Old.md" }, dependencies),
		).resolves.toEqual({ path: "Notes/Old.md", trashed: true });
		expect(run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"delete",
			"path=Notes/Old.md",
		]);
		expect(run.mock.calls[1]?.[1]).not.toContain("permanent");
	});

	it("tests both the CLI version and configured vault", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "1.12.7", code: 0 },
			{ output: "C:\\Vaults\\Fornbok", code: 0 },
		]);

		await expect(
			testObsidianConnection("Fornbok", dependencies),
		).resolves.toEqual({
			version: "1.12.7",
			vaultPath: "C:\\Vaults\\Fornbok",
		});
		expect(run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "version"]);
		expect(run.mock.calls[2]?.[1]).toEqual([
			"vault=Fornbok",
			"vault",
			"info=path",
		]);
	});

	it("starts the trusted Windows desktop app and retries when the redirector cannot find it", async () => {
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{
				output:
					"The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.",
				code: 1,
			},
			{
				output: JSON.stringify({ running: true, started: true, id: 1234 }),
				code: 0,
			},
			{ output: "1.12.7", code: 0 },
			{ output: "C:\\Vaults\\Fornbok", code: 0 },
		]);
		const wait = vi.fn(async () => {});
		const retryDependencies = { ...dependencies, wait };

		await expect(
			testObsidianConnection("Fornbok", retryDependencies),
		).resolves.toEqual({
			version: "1.12.7",
			vaultPath: "C:\\Vaults\\Fornbok",
		});
		expect(run.mock.calls[2]?.[0]).toBe("powershell.exe");
		expect(run.mock.calls[2]?.[1]).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			expect.stringContaining("Get-Process -Name Obsidian"),
			"C:\\Users\\kyle\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe",
		]);
		expect(wait).toHaveBeenCalledWith(500);
		expect(run.mock.calls[3]?.[1]).toEqual(["vault=Fornbok", "version"]);
	});

	it("waits up to the bounded cold-start timeout for the Obsidian CLI", async () => {
		const unavailable = {
			output:
				"The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.",
			code: 1,
		};
		const { dependencies } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			unavailable,
			{
				output: JSON.stringify({ running: true, started: false, id: 1234 }),
				code: 0,
			},
			...Array.from({ length: 40 }, () => unavailable),
		]);
		const wait = vi.fn(async () => {});

		await expect(
			getActiveObsidianNote("Fornbok", { ...dependencies, wait }),
		).rejects.toThrow(
			"Obsidian is running, but its CLI was not ready after 20 seconds. Check Obsidian for a blocking error dialog, then fully close and reopen Obsidian. Retry after your vault finishes loading.",
		);
		expect(wait).toHaveBeenCalledTimes(40);
		expect(wait).toHaveBeenLastCalledWith(500);
	});

	it("does not relaunch Obsidian for a post-command active-note snapshot", async () => {
		const unavailable =
			"The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.";
		const { dependencies, run } = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: unavailable, code: 1 },
		]);

		await expect(
			getActiveObsidianNote("Fornbok", dependencies, {
				launchIfNeeded: false,
			}),
		).rejects.toThrow("unable to find Obsidian");
		expect(run).toHaveBeenCalledTimes(2);
		expect(
			run.mock.calls.some(([command]) => command === "powershell.exe"),
		).toBe(true);
		// The only PowerShell call is CLI detection. No desktop start attempt follows.
		expect(
			run.mock.calls.filter(([command]) => command === "powershell.exe"),
		).toHaveLength(1);
	});

	it("creates a composer reference without exposing an absolute path", () => {
		expect(obsidianReferenceItem("Projects/One thing.md")).toEqual({
			relativePath: "Projects/One thing.md",
			name: "One thing.md",
			directory: "Projects",
		});
	});

	it("maps read-only graph queries to curated CLI commands", async () => {
		const backlinks = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "[]", code: 0 },
		]);
		await queryObsidianLinks(
			"Fornbok",
			{ kind: "backlinks", path: "Notes/One.md", counts: true },
			backlinks.dependencies,
		);
		expect(backlinks.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"backlinks",
			"path=Notes/One.md",
			"counts",
			"format=json",
		]);

		const unresolved = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "[]", code: 0 },
		]);
		await queryObsidianLinks(
			"Fornbok",
			{ kind: "unresolved", counts: true },
			unresolved.dependencies,
		);
		expect(unresolved.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"unresolved",
			"counts",
			"verbose",
			"format=json",
		]);
	});

	it("maps bounded vault search to indexed path, context, and count commands", async () => {
		const paths = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: '["1 Projects/Body.md"]', code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output: "1 Projects/project ship.md\n1 Projects/Other.md",
				code: 0,
			},
		]);
		await expect(
			queryObsidianSearch(
				"Fornbok",
				{
					query: "project ship",
					path: "1 Projects",
					caseSensitive: true,
					limit: 10,
				},
				paths.dependencies,
			),
		).resolves.toBe('["1 Projects/project ship.md","1 Projects/Body.md"]');
		expect(paths.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"search",
			"query=project ship",
			"path=1 Projects",
			"case",
			"limit=10",
			"format=json",
		]);
		expect(paths.run.mock.calls[3]?.[1]).toEqual([
			"vault=Fornbok",
			"files",
			"folder=1 Projects",
			"ext=md",
		]);

		const context = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "1 Projects/Hlid.md:8: project ship", code: 0 },
		]);
		await queryObsidianSearch(
			"Fornbok",
			{ query: "project ship", context: true },
			context.dependencies,
		);
		expect(context.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"search:context",
			"query=project ship",
		]);

		const total = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "12", code: 0 },
		]);
		await queryObsidianSearch(
			"Fornbok",
			{ query: "project ship", context: true, countOnly: true },
			total.dependencies,
		);
		expect(total.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"search",
			"query=project ship",
			"total",
		]);
	});

	it("combines filename, content, backlinks, and outgoing links when requested", async () => {
		const graph = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: '["Projects/Yggdrasil.md"]', code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Projects/Yggdrasil.md\nProjects/Other.md", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: windowsDetection, code: 0 },
			{
				output:
					'[{"file":"Projects/Gandr.md"},{"file":"Projects/Yggdrasil.md"}]',
				code: 0,
			},
			{ output: "Projects/Galdur.md\nProjects/Gandr.md", code: 0 },
		]);

		await expect(
			queryObsidianSearch(
				"Fornbok",
				{ query: "Yggdrasil", includeGraph: true, limit: 10 },
				graph.dependencies,
			),
		).resolves.toBe(
			JSON.stringify([
				{
					path: "Projects/Yggdrasil.md",
					sources: ["filename", "content"],
				},
				{
					path: "Projects/Gandr.md",
					sources: ["backlink", "outgoing"],
					relatedTo: ["Projects/Yggdrasil.md"],
				},
				{
					path: "Projects/Galdur.md",
					sources: ["outgoing"],
					relatedTo: ["Projects/Yggdrasil.md"],
				},
			]),
		);
		expect(graph.run.mock.calls[6]?.[1]).toEqual([
			"vault=Fornbok",
			"backlinks",
			"path=Projects/Yggdrasil.md",
			"format=json",
		]);
		expect(graph.run.mock.calls[7]?.[1]).toEqual([
			"vault=Fornbok",
			"links",
			"path=Projects/Yggdrasil.md",
		]);
	});

	it("preserves direct results when part of graph expansion fails", async () => {
		const graph = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: '["Projects/Yggdrasil.md"]', code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Projects/Yggdrasil.md", code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: windowsDetection, code: 0 },
			{ output: "Backlinks temporarily unavailable", code: 1 },
			{ output: "Projects/Galdur.md", code: 0 },
		]);

		await expect(
			queryObsidianSearch(
				"Fornbok",
				{ query: "Yggdrasil", includeGraph: true, limit: 10 },
				graph.dependencies,
			),
		).resolves.toBe(
			JSON.stringify([
				{
					path: "Projects/Yggdrasil.md",
					sources: ["filename", "content"],
					graphUnavailable: ["backlinks"],
				},
				{
					path: "Projects/Galdur.md",
					sources: ["outgoing"],
					relatedTo: ["Projects/Yggdrasil.md"],
				},
			]),
		);
	});

	it("keeps graph expansion separate from context and count searches", async () => {
		await expect(
			queryObsidianSearch("Fornbok", {
				query: "Yggdrasil",
				context: true,
				includeGraph: true,
			}),
		).rejects.toThrow("cannot be combined");
	});

	it("maps current-note reads, outlines, and metadata without a file path", async () => {
		const read = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "# Current", code: 0 },
		]);
		await queryObsidianCurrentNote(
			"Fornbok",
			{ action: "read" },
			read.dependencies,
		);
		expect(read.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "read"]);

		const outline = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "[]", code: 0 },
		]);
		await queryObsidianCurrentNote(
			"Fornbok",
			{ action: "outline" },
			outline.dependencies,
		);
		expect(outline.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"outline",
			"format=json",
		]);

		const total = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "4", code: 0 },
		]);
		await queryObsidianCurrentNote(
			"Fornbok",
			{ action: "outline", countOnly: true },
			total.dependencies,
		);
		expect(total.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"outline",
			"total",
		]);

		const info = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "path Notes/Current.md", code: 0 },
		]);
		await queryObsidianCurrentNote(
			"Fornbok",
			{ action: "info" },
			info.dependencies,
		);
		expect(info.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "file"]);
	});

	it("reads and opens today's daily note through Obsidian's native commands", async () => {
		const read = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Journal\\2026-07-20.md", code: 0 },
			{ output: "# Daily\nBody", code: 0 },
		]);
		await expect(
			readObsidianDailyNote("Fornbok", read.dependencies),
		).resolves.toEqual({
			path: "Journal/2026-07-20.md",
			content: "# Daily\nBody",
		});
		expect(read.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"daily:path",
		]);
		expect(read.run.mock.calls[2]?.[1]).toEqual([
			"vault=Fornbok",
			"daily:read",
		]);

		const open = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "Opened", code: 0 },
			{ output: "Journal\\2026-07-20.md", code: 0 },
		]);
		await expect(
			openObsidianDailyNote("Fornbok", open.dependencies),
		).resolves.toEqual({ path: "Journal/2026-07-20.md" });
		expect(open.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "daily"]);
		expect(open.run.mock.calls[2]?.[1]).toEqual([
			"vault=Fornbok",
			"daily:path",
		]);
	});

	it("reads one exact vault path and reports first-class vault identity", async () => {
		const exact = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "# Yggdrasil", code: 0 },
		]);
		await expect(
			readObsidianNote(
				"Fornbok",
				"1 Projects/Yggdrasil.md",
				exact.dependencies,
			),
		).resolves.toBe("# Yggdrasil");
		expect(exact.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"read",
			"path=1 Projects/Yggdrasil.md",
		]);

		const info = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "1.12.7", code: 0 },
			{ output: "path: Notes/Current.md", code: 0 },
		]);
		await expect(
			queryObsidianVaultInfo("Fornbok", info.dependencies),
		).resolves.toEqual({
			name: "Fornbok",
			version: "1.12.7",
			activeNote: "Notes/Current.md",
		});
		expect(info.run.mock.calls[1]?.[1]).toEqual(["vault=Fornbok", "version"]);
		expect(info.run.mock.calls[2]?.[1]).toEqual(["vault=Fornbok", "file"]);
	});

	it("maps task and property queries to structured output", async () => {
		const tasks = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "[]", code: 0 },
		]);
		await queryObsidianTasks(
			"Fornbok",
			{ path: "Projects/Ship.md", state: "todo", status: "?" },
			tasks.dependencies,
		);
		expect(tasks.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"tasks",
			"path=Projects/Ship.md",
			"todo",
			"status=?",
			"verbose",
			"format=json",
		]);

		const properties = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "{}", code: 0 },
		]);
		await queryObsidianProperties(
			"Fornbok",
			{ path: "Projects/Ship.md", name: "status" },
			properties.dependencies,
		);
		expect(properties.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"properties",
			"path=Projects/Ship.md",
			"name=status",
			"format=json",
		]);
	});

	it("updates exact tasks and typed properties through native commands", async () => {
		const task = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await expect(
			updateObsidianTask(
				"Fornbok",
				{ path: "Projects/Ship.md", line: 14, action: "done" },
				task.dependencies,
			),
		).resolves.toEqual({
			path: "Projects/Ship.md",
			line: 14,
			action: "done",
		});
		expect(task.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"task",
			"path=Projects/Ship.md",
			"line=14",
			"done",
		]);

		const customTask = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await updateObsidianTask(
			"Fornbok",
			{
				path: "Projects/Ship.md",
				line: 15,
				action: "status",
				status: "?",
			},
			customTask.dependencies,
		);
		expect(customTask.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"task",
			"path=Projects/Ship.md",
			"line=15",
			"status=?",
		]);

		const property = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await expect(
			setObsidianProperty(
				"Fornbok",
				{
					path: "Projects/Ship.md",
					name: "owners",
					type: "list",
					value: ["Kyle", "Munin"],
				},
				property.dependencies,
			),
		).resolves.toEqual({
			path: "Projects/Ship.md",
			name: "owners",
			type: "list",
			value: ["Kyle", "Munin"],
		});
		expect(property.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"property:set",
			"path=Projects/Ship.md",
			"name=owners",
			"value=Kyle,Munin",
			"type=list",
		]);

		const remove = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await expect(
			removeObsidianProperty(
				"Fornbok",
				{ path: "Projects/Ship.md", name: "owners" },
				remove.dependencies,
			),
		).resolves.toEqual({ path: "Projects/Ship.md", name: "owners" });
		expect(remove.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"property:remove",
			"path=Projects/Ship.md",
			"name=owners",
		]);
	});

	it("rejects invalid task and typed property values before invoking Obsidian", async () => {
		await expect(
			updateObsidianTask("Fornbok", {
				path: "Projects/Ship.md",
				line: 14,
				action: "status",
			}),
		).rejects.toThrow("one character");
		await expect(
			setObsidianProperty("Fornbok", {
				path: "Projects/Ship.md",
				name: "done",
				type: "checkbox",
				value: "yes",
			}),
		).rejects.toThrow("require a boolean");
	});

	it("uses native count-only commands for broad agent queries", async () => {
		const links = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "10", code: 0 },
		]);
		await queryObsidianLinks(
			"Fornbok",
			{ kind: "unresolved", countOnly: true },
			links.dependencies,
		);
		expect(links.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"unresolved",
			"total",
		]);

		const tasks = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "494", code: 0 },
		]);
		await queryObsidianTasks(
			"Fornbok",
			{ state: "todo", countOnly: true },
			tasks.dependencies,
		);
		expect(tasks.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"tasks",
			"todo",
			"total",
		]);

		const properties = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "48", code: 0 },
		]);
		await queryObsidianProperties(
			"Fornbok",
			{ countOnly: true },
			properties.dependencies,
		);
		expect(properties.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"properties",
			"total",
		]);
	});

	it("maps Base and history reads without exposing restore operations", async () => {
		const base = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "[]", code: 0 },
		]);
		await queryObsidianBase(
			"Fornbok",
			"Dashboards/Work.base",
			"Open",
			base.dependencies,
		);
		expect(base.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"base:query",
			"path=Dashboards/Work.base",
			"view=Open",
			"format=json",
		]);

		const create = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "", code: 0 },
		]);
		await expect(
			createObsidianBaseItem(
				"Fornbok",
				{
					path: "Dashboards/Work.base",
					view: "Open",
					name: "New item",
					content: "# New item",
					open: true,
				},
				create.dependencies,
			),
		).resolves.toEqual({
			basePath: "Dashboards/Work.base",
			view: "Open",
			name: "New item",
		});
		expect(create.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"base:create",
			"path=Dashboards/Work.base",
			"view=Open",
			"name=New item",
			"content=# New item",
			"open",
		]);

		const history = wslDependencies([
			{ output: windowsDetection, code: 0 },
			{ output: "diff", code: 0 },
		]);
		await queryObsidianHistory(
			"Fornbok",
			{
				action: "diff",
				path: "Notes/One.md",
				from: 2,
				to: 1,
				filter: "local",
			},
			history.dependencies,
		);
		expect(history.run.mock.calls[1]?.[1]).toEqual([
			"vault=Fornbok",
			"diff",
			"path=Notes/One.md",
			"from=2",
			"to=1",
			"filter=local",
		]);
	});

	it("rejects vault traversal before launching Obsidian", async () => {
		const { dependencies, run } = wslDependencies([]);
		await expect(
			queryObsidianLinks(
				"Fornbok",
				{ kind: "backlinks", path: "../Secrets.md" },
				dependencies,
			),
		).rejects.toThrow("inside the configured vault");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects unsafe search input before launching Obsidian", async () => {
		const { dependencies, run } = wslDependencies([]);
		await expect(
			queryObsidianSearch("Fornbok", { query: "one\ntwo" }, dependencies),
		).rejects.toThrow("search query is invalid");
		expect(run).not.toHaveBeenCalled();
	});
});
