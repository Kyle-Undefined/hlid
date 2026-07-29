import { describe, expect, it, vi } from "vitest";
import { captureBoundedBunStderr, runBoundedProcess } from "./process";

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

	it("captures the bounded tail of a Bun child stderr stream", async () => {
		const encoder = new TextEncoder();
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("prefix-"));
				controller.enqueue(encoder.encode("tail"));
				controller.close();
			},
		});
		const captured = captureBoundedBunStderr(
			{ stderr } as ReturnType<typeof Bun.spawn>,
			{ maxChars: 6 },
		);

		await vi.waitFor(() => expect(captured()).toBe("x-tail"));
	});
});
