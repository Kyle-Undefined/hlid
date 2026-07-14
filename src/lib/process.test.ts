import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "./process";

describe("runBoundedProcess", () => {
	it("captures combined output and preserves the exit code", async () => {
		const result = await runBoundedProcess(
			process.execPath,
			[
				"-e",
				'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3',
			],
			{ timeoutMs: 2_000, timeoutError: "timed out" },
		);
		expect(result.code).toBe(3);
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	it("bounds captured output", async () => {
		const result = await runBoundedProcess(
			process.execPath,
			["-e", 'process.stdout.write("x".repeat(100_000))'],
			{
				timeoutMs: 2_000,
				timeoutError: "timed out",
				maxOutputChars: 100,
			},
		);
		expect(result.code).toBe(0);
		expect(result.output.length).toBe(100);
	});

	it("kills a process that exceeds its deadline", async () => {
		await expect(
			runBoundedProcess(
				process.execPath,
				["-e", "setInterval(() => {}, 1_000)"],
				{ timeoutMs: 50, timeoutError: "custom timeout" },
			),
		).rejects.toThrow("custom timeout");
	});

	it("surfaces spawn errors", async () => {
		await expect(
			runBoundedProcess("hlid-command-that-does-not-exist", [], {
				timeoutMs: 2_000,
				timeoutError: "timed out",
			}),
		).rejects.toThrow();
	});
});
