import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acpExecutableNames,
	acpExecutablePathCandidates,
	findAcpExecutable,
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
});
