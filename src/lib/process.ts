import { spawn } from "node:child_process";

export type CapturedProcessResult = {
	stdout: string;
	stderr: string;
	code: number;
};

export type BoundedProcessResult = {
	output: string;
	code: number | null;
};

export type BoundedProcessOptions = {
	timeoutMs: number;
	timeoutError: string;
	maxOutputChars?: number;
	shell?: boolean;
	cwd?: string;
};

/** Run a child with bounded combined output and a hard timeout. */
export function runBoundedProcess(
	executable: string,
	args: string[],
	options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: options.shell ?? false,
			cwd: options.cwd,
		});
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const append = (chunk: Buffer | string) => {
			const remaining = (options.maxOutputChars ?? 8_192) - output.length;
			if (remaining > 0) output += chunk.toString().slice(0, remaining);
		};
		const finish = (error?: Error, code: number | null = null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve({ output, code });
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(undefined, code));
		timer = setTimeout(() => {
			child.kill();
			finish(new Error(options.timeoutError));
		}, options.timeoutMs);
	});
}

export async function runCapturedProcess(
	command: string[],
): Promise<CapturedProcessResult> {
	const process = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	// Drain both pipes while awaiting exit so a noisy child cannot deadlock.
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { stdout, stderr, code };
}
