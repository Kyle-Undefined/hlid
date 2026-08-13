import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acpExecutionAdapterInternals,
	createAcpExecutionAdapter,
	wslArchitectureFromUname,
} from "./acpExecutionAdapter";

const {
	adaptInternalMcpServer,
	parseWslExecutableBatchOutput,
	withWslEnvironment,
	wslLaunch,
	wslExecutableBatchProbeLaunch,
	wslExecutableProbeLaunch,
	wslPathAccessible,
	wslProviderPath,
	wslTerminationHelper,
} = acpExecutionAdapterInternals;

describe("ACP execution adapter", () => {
	it("keeps host paths unchanged for a host runtime", () => {
		const adapter = createAcpExecutionAdapter({ kind: "host" });
		expect(adapter.providerPath("C:\\work", "C:\\work\\file.txt")).toBe(
			"C:\\work\\file.txt",
		);
	});

	it("batch-resolves host commands against one exact launch environment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hlid-acp-host-batch-"));
		const command = `hlid-host-batch-${process.pid}`;
		const filename = process.platform === "win32" ? `${command}.cmd` : command;
		const executable = join(directory, filename);
		writeFileSync(
			executable,
			process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
		);
		if (process.platform !== "win32") chmodSync(executable, 0o755);
		try {
			const adapter = createAcpExecutionAdapter({ kind: "host" });
			await expect(
				adapter.resolveExecutables?.([command, "missing-host-agent"], {
					hostCwd: directory,
					env: {
						PATH: [directory].join(delimiter),
						PATHEXT: process.platform === "win32" ? ".CMD" : undefined,
					},
					timeoutMs: 1_000,
				}),
			).resolves.toEqual(
				new Map([
					[command, executable],
					["missing-host-agent", null],
				]),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("translates paths only for the exact WSL target", () => {
		const cwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo";
		expect(wslProviderPath("Ubuntu-24.04", cwd, cwd)).toBe("/home/kyle/repo");
		expect(
			wslProviderPath(
				"Ubuntu-24.04",
				cwd,
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\other",
			),
		).toBe("/home/kyle/other");
		expect(
			wslPathAccessible(
				"Debian",
				cwd,
				"\\\\wsl.localhost\\Debian\\home\\kyle\\other",
			),
		).toBe(false);
	});

	it("translates an exact-distro WSL resource from a Windows workspace", () => {
		expect(
			wslProviderPath(
				"Ubuntu-24.04",
				"C:\\work\\repo",
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\shared",
			),
		).toBe("/home/kyle/shared");
		expect(
			wslProviderPath("Ubuntu-24.04", "C:\\work\\repo", "C:\\work\\repo"),
		).toBe("/mnt/c/work/repo");
	});

	it("rejects another distro's UNC resource even from a Windows workspace", () => {
		expect(
			wslPathAccessible(
				"Ubuntu-24.04",
				"C:\\work\\repo",
				"\\\\wsl.localhost\\Debian\\home\\kyle\\shared",
			),
		).toBe(false);
		expect(
			wslPathAccessible(
				"Ubuntu-24.04",
				"C:\\work\\repo",
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\shared",
			),
		).toBe(true);
	});

	it("replaces inherited WSLENV with only explicitly forwarded values", () => {
		expect(
			withWslEnvironment(
				{ WSLENV: "PATH/l:API_TOKEN/w", API_TOKEN: "secret", MODE: "test" },
				["API_TOKEN", "MODE"],
				"u",
			).WSLENV,
		).toBe("API_TOKEN/u:MODE/u");
	});

	it("maps supported WSL registry architectures", () => {
		expect(wslArchitectureFromUname("x86_64\n")).toBe("x64");
		expect(wslArchitectureFromUname("aarch64")).toBe("arm64");
		expect(() => wslArchitectureFromUname("riscv64")).toThrow(
			"Unsupported WSL architecture: riscv64",
		);
	});

	it("launches WSL ACP argv without interpolating arguments through a shell", () => {
		const cwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo";
		const launch = wslLaunch("Ubuntu-24.04", "/opt/agent/bin/acp", {
			command: "agent",
			args: ["--name", "literal; touch /tmp/no"],
			hostCwd: cwd,
			env: { TOKEN: "secret" },
			forwardedEnvNames: ["TOKEN"],
			spawnTimeoutMs: 1_000,
			preparationTimeoutMs: 1_000,
		});
		expect(launch.executable).toBe("wsl.exe");
		expect(launch.shell).toBe(false);
		expect(launch.args.slice(-3)).toEqual([
			"/opt/agent/bin/acp",
			"--name",
			"literal; touch /tmp/no",
		]);
		expect(launch.env.WSLENV).toBe("TOKEN/u");
	});

	it("resolves WSL commands in the exact target with only explicit environment", () => {
		const probe = wslExecutableProbeLaunch(
			"Ubuntu-24.04",
			"agent; touch no",
			"/home/kyle/repo",
			{
				TOKEN: "explicit",
				HOST_SECRET: "inherited",
				WSLENV: "HOST_SECRET/u",
			},
			["TOKEN"],
		);
		expect(probe.executable).toBe("wsl.exe");
		expect(probe.args.slice(0, 4)).toEqual([
			"-d",
			"Ubuntu-24.04",
			"--cd",
			"/home/kyle/repo",
		]);
		expect(probe.args.at(-1)).toBe("agent; touch no");
		expect(probe.env.WSLENV).toBe("TOKEN/u");
		expect(probe.args.at(-3)).toContain("/mnt/[A-Za-z]/*");
	});

	it("honors an explicitly configured WSL PATH without filtering it", () => {
		const probe = wslExecutableProbeLaunch(
			"Ubuntu-24.04",
			"agent",
			"/home/kyle/repo",
			{ PATH: "/custom/bin:/mnt/c/custom" },
			["PATH"],
		);
		expect(probe.args.at(-3)).not.toContain("/mnt/[A-Za-z]/*");
		expect(probe.env.WSLENV).toBe("PATH/u");
	});

	it("keeps filtering inherited Windows paths for a mixed-case Path variable", () => {
		const single = wslExecutableProbeLaunch(
			"Ubuntu-24.04",
			"agent",
			"/home/kyle/repo",
			{ Path: "/mnt/c/custom" },
			["Path"],
		);
		expect(single.args.at(-3)).toContain("/mnt/[A-Za-z]/*");
		expect(single.env.WSLENV).toBe("Path/u");

		const batch = wslExecutableBatchProbeLaunch(
			"Ubuntu-24.04",
			["agent", "missing"],
			"/home/kyle/repo",
			{ Path: "/mnt/c/custom" },
			["Path"],
		);
		expect(
			batch.args.find((value) => value.includes("for candidate")),
		).toContain("/mnt/[A-Za-z]/*");
		expect(batch.env.WSLENV).toBe("Path/u");
	});

	it("resolves a command batch in one exact WSL invocation without shell interpolation", () => {
		const commands = [
			"agent",
			"/mnt/c/Hlid/managed/opencode",
			"literal; touch /tmp/no",
		];
		const probe = wslExecutableBatchProbeLaunch(
			"Ubuntu-24.04",
			commands,
			"/home/kyle/repo",
			{ TOKEN: "explicit", WSLENV: "HOST_SECRET/u" },
			["TOKEN"],
		);
		expect(probe.executable).toBe("wsl.exe");
		expect(probe.args.slice(0, 4)).toEqual([
			"-d",
			"Ubuntu-24.04",
			"--cd",
			"/home/kyle/repo",
		]);
		expect(probe.args.slice(-commands.length)).toEqual(commands);
		expect(probe.env.WSLENV).toBe("TOKEN/u");
		expect(
			probe.args.find((value) => value.includes("for candidate")),
		).toContain("/mnt/[A-Za-z]/*");
	});

	it("maps bounded NUL-delimited WSL batch results back to exact commands", () => {
		const commands = ["agent", "/mnt/c/Hlid/opencode", "missing"];
		expect(
			parseWslExecutableBatchOutput(
				commands,
				"login banner\\n\0/usr/bin/agent\0/mnt/c/Hlid/opencode\0\0",
			),
		).toEqual(
			new Map([
				["agent", "/usr/bin/agent"],
				["/mnt/c/Hlid/opencode", "/mnt/c/Hlid/opencode"],
				["missing", null],
			]),
		);
		expect(parseWslExecutableBatchOutput(commands, "malformed output")).toEqual(
			new Map(commands.map((command) => [command, null])),
		);
	});

	it("launches a managed /mnt executable from a Windows cwd in the exact distro", () => {
		const launch = wslLaunch(
			"Ubuntu-24.04",
			"/mnt/c/Hlid/integrations/acp/opencode",
			{
				command: "/mnt/c/Hlid/integrations/acp/opencode",
				args: ["acp"],
				hostCwd: "C:\\Users\\kyle\\project",
				env: {},
				spawnTimeoutMs: 1_000,
				preparationTimeoutMs: 1_000,
			},
		);
		expect(launch.args.slice(0, 4)).toEqual([
			"-d",
			"Ubuntu-24.04",
			"--cd",
			"/mnt/c/Users/kyle/project",
		]);
		expect(launch.args.slice(-2)).toEqual([
			"/mnt/c/Hlid/integrations/acp/opencode",
			"acp",
		]);
	});

	it("does not expose unrelated inherited host environment values to WSL", () => {
		const cwd = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\repo";
		const launch = wslLaunch("Ubuntu-24.04", "/opt/agent/bin/acp", {
			command: "agent",
			args: [],
			hostCwd: cwd,
			env: {
				TOKEN: "explicit",
				HOST_SECRET: "inherited",
				WSLENV: "HOST_SECRET/u:PATH/l",
			},
			forwardedEnvNames: ["TOKEN"],
			spawnTimeoutMs: 1_000,
			preparationTimeoutMs: 1_000,
		});
		expect(launch.env.WSLENV).toBe("TOKEN/u");
		expect(launch.env.WSLENV).not.toContain("HOST_SECRET");
	});

	it("runs Hlid-owned Windows MCP servers through WSL interop over stdio", () => {
		const server = adaptInternalMcpServer({
			name: "hlid",
			command: "C:\\Users\\kyle\\AppData\\Local\\Hlid\\hlid.exe",
			args: ["--internal-hlid-mcp"],
			env: [
				{ name: "HLID_SKIP_SELF_INSTALL", value: "1" },
				{ name: "HLID_INTERNAL_MCP_RUNTIME_CWD", value: "C:\\work" },
			],
		});
		expect(server.command).toBe(
			"/mnt/c/Users/kyle/AppData/Local/Hlid/hlid.exe",
		);
		expect(server.env).toContainEqual({
			name: "WSLENV",
			value: "HLID_INTERNAL_MCP_RUNTIME_CWD/w:HLID_SKIP_SELF_INSTALL/w",
		});
	});

	it("translates a Windows development entrypoint for an internal MCP server", () => {
		const server = adaptInternalMcpServer({
			name: "hlid",
			command: "C:\\Program Files\\Bun\\bun.exe",
			args: ["C:\\src\\hlid\\src\\cli.ts", "--internal-hlid-mcp"],
			env: [{ name: "HLID_SKIP_SELF_INSTALL", value: "1" }],
		});
		expect(server.args).toEqual([
			"/mnt/c/src/hlid/src/cli.ts",
			"--internal-hlid-mcp",
		]);
	});

	it("cleans up the exact WSL process group without inheriting WSLENV", () => {
		const helper = wslTerminationHelper({
			distro: "Ubuntu-24.04",
			processGroupFile: "/tmp/hlid-acp-exact.pid",
		});
		expect(helper.executable).toBe("wsl.exe");
		expect(helper.args.slice(0, 2)).toEqual(["-d", "Ubuntu-24.04"]);
		expect(helper.args).toContainEqual(expect.stringContaining("attempt=0"));
		expect(helper.args.at(-1)).toBe("/tmp/hlid-acp-exact.pid");
		expect(helper.env.WSLENV).toBe("");
	});

	it("does not rewrite project-owned MCP commands", () => {
		const server = {
			name: "project",
			command: "C:\\tools\\project.exe",
			args: [],
			env: [{ name: "PROJECT_TOKEN", value: "secret" }],
		};
		expect(adaptInternalMcpServer(server)).toBe(server);
	});
});
