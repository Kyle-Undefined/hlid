import { describe, expect, it, vi } from "vitest";
import {
	appendToObsidian,
	getActiveObsidianNote,
	getObsidianCliStatus,
	MAX_OBSIDIAN_APPEND_CHARS,
	obsidianReferenceItem,
	openObsidianNote,
	queryObsidianBase,
	queryObsidianHistory,
	queryObsidianLinks,
	queryObsidianProperties,
	queryObsidianTasks,
	testObsidianConnection,
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
					"path Notes\\Current note.md\r\nname Current note\r\nextension md",
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
			{ output: "", code: 0 },
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
			"& { param([string]$path) Start-Process -FilePath $path }",
			"C:\\Users\\kyle\\AppData\\Local\\Programs\\Obsidian\\Obsidian.exe",
		]);
		expect(wait).toHaveBeenCalledWith(500);
		expect(run.mock.calls[3]?.[1]).toEqual(["vault=Fornbok", "version"]);
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
});
