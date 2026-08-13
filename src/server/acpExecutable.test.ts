import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acpExecutableInternals,
	acpExecutableNames,
	acpExecutablePathCandidates,
	findAcpExecutable,
	findAcpExecutables,
} from "./acpExecutable";

const originalPath = process.env.PATH;

function installExecutable(directory: string, command: string): string {
	const filename = process.platform === "win32" ? `${command}.cmd` : command;
	const executable = join(directory, filename);
	writeFileSync(
		executable,
		process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
	);
	if (process.platform !== "win32") chmodSync(executable, 0o755);
	return executable;
}

afterEach(() => {
	process.env.PATH = originalPath;
});

describe.sequential("findAcpExecutable", () => {
	it("uses Windows PATHEXT shims without selecting npm's bare POSIX shim", () => {
		expect(
			acpExecutableNames("pi-acp", ".COM;.EXE;.BAT;.CMD", "win32"),
		).toEqual(["pi-acp.com", "pi-acp.exe", "pi-acp.bat", "pi-acp.cmd"]);
		expect(
			acpExecutableNames("pi-acp.exe", ".COM;.EXE;.BAT;.CMD", "win32"),
		).toEqual(["pi-acp.exe"]);
	});

	it("orders Windows PATH directories before PATHEXT variants", () => {
		expect(
			acpExecutablePathCandidates(
				"opencode",
				["C:\\nvm4w\\nodejs", "C:\\Users\\kyle\\.bun\\bin"],
				".EXE;.CMD",
				"win32",
			),
		).toEqual([
			"C:\\nvm4w\\nodejs\\opencode.exe",
			"C:\\nvm4w\\nodejs\\opencode.cmd",
			"C:\\Users\\kyle\\.bun\\bin\\opencode.exe",
			"C:\\Users\\kyle\\.bun\\bin\\opencode.cmd",
		]);
	});

	it("re-probes a cached PATH directory after a command is installed", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-path-"));
		const command = `hlid-acp-late-${process.pid}`;
		process.env.PATH = [directory, originalPath]
			.filter(Boolean)
			.join(delimiter);
		try {
			await expect(findAcpExecutable(command)).resolves.toBeNull();
			const executable = installExecutable(directory, command);
			await expect(findAcpExecutable(command)).resolves.toBe(executable);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("prefers a newly installed command ahead of a cached lower-priority executable", async () => {
		const first = mkdtempSync(join(tmpdir(), "hlid-acp-path-first-"));
		const second = mkdtempSync(join(tmpdir(), "hlid-acp-path-second-"));
		const command = `hlid-acp-priority-${process.pid}`;
		process.env.PATH = [first, second, originalPath]
			.filter(Boolean)
			.join(delimiter);
		try {
			const lowerPriority = installExecutable(second, command);
			await expect(findAcpExecutable(command)).resolves.toBe(lowerPriority);

			const higherPriority = installExecutable(first, command);
			await expect(findAcpExecutable(command)).resolves.toBe(higherPriority);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("resolves explicit relative commands against the launch cwd", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-relative-"));
		try {
			const executable = installExecutable(directory, "relative-agent");
			const command =
				process.platform === "win32"
					? ".\\relative-agent.cmd"
					: "./relative-agent";
			await expect(
				findAcpExecutable(command, { cwd: directory }),
			).resolves.toBe(executable);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses the ACP launch environment's PATH", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-env-path-"));
		const command = `hlid-acp-env-${process.pid}`;
		try {
			const executable = installExecutable(directory, command);
			await expect(
				findAcpExecutable(command, {
					env: {
						PATH: directory,
						PATHEXT: process.platform === "win32" ? ".CMD" : undefined,
					},
				}),
			).resolves.toBe(executable);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not report a directory as an executable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-directory-"));
		try {
			await expect(findAcpExecutable(directory)).resolves.toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("resolves a batch against one PATH group while preserving explicit paths and misses", async () => {
		const first = mkdtempSync(join(tmpdir(), "hlid-acp-batch-first-"));
		const second = mkdtempSync(join(tmpdir(), "hlid-acp-batch-second-"));
		try {
			const firstCommand = `hlid-acp-batch-first-${process.pid}`;
			const secondCommand = `hlid-acp-batch-second-${process.pid}`;
			const firstExecutable = installExecutable(first, firstCommand);
			const secondExecutable = installExecutable(second, secondCommand);
			const explicitExecutable = installExecutable(second, "explicit-agent");
			const missing = `hlid-acp-batch-missing-${process.pid}`;
			const commands = [
				secondCommand,
				firstCommand,
				explicitExecutable,
				missing,
				secondCommand,
			];

			await expect(
				findAcpExecutables(commands, {
					env: {
						PATH: [first, second].join(delimiter),
						PATHEXT: process.platform === "win32" ? ".CMD" : undefined,
					},
				}),
			).resolves.toEqual(
				new Map([
					[secondCommand, secondExecutable],
					[firstCommand, firstExecutable],
					[explicitExecutable, explicitExecutable],
					[missing, null],
				]),
			);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("re-probes fresh higher-priority and previously missing commands in a batch", async () => {
		const first = mkdtempSync(join(tmpdir(), "hlid-acp-batch-fresh-first-"));
		const second = mkdtempSync(join(tmpdir(), "hlid-acp-batch-fresh-second-"));
		const command = `hlid-acp-batch-priority-${process.pid}`;
		const lateCommand = `hlid-acp-batch-late-${process.pid}`;
		const env = {
			PATH: [first, second].join(delimiter),
			PATHEXT: process.platform === "win32" ? ".CMD" : undefined,
		};
		try {
			const lowerPriority = installExecutable(second, command);
			await expect(
				findAcpExecutables([command, lateCommand], { env }),
			).resolves.toEqual(
				new Map([
					[command, lowerPriority],
					[lateCommand, null],
				]),
			);

			const higherPriority = installExecutable(first, command);
			const lateExecutable = installExecutable(first, lateCommand);
			await expect(
				findAcpExecutables([command, lateCommand], { env }),
			).resolves.toEqual(
				new Map([
					[command, higherPriority],
					[lateCommand, lateExecutable],
				]),
			);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("uses one fresh PATH index and no candidate probes for a batch of misses", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-batch-bounded-"));
		try {
			acpExecutableInternals.resetIoCounters();
			const commands = Array.from(
				{ length: 38 },
				(_value, index) => `missing-acp-agent-${process.pid}-${index}`,
			);
			await expect(
				findAcpExecutables(commands, {
					env: {
						PATH: directory,
						PATHEXT:
							process.platform === "win32" ? ".EXE;.BAT;.CMD" : undefined,
					},
				}),
			).resolves.toEqual(new Map(commands.map((command) => [command, null])));
			expect(acpExecutableInternals.ioCounters()).toEqual({
				pathIndexBuildCount: 1,
				candidateValidationCount: 0,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
