export type CapturedProcessResult = {
	stdout: string;
	stderr: string;
	code: number;
};

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
