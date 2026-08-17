import { mkdirSync, rmSync } from "node:fs";

export async function listZipEntries(
	archive: string,
	errorMessage: string,
): Promise<string[]> {
	for (const command of [
		["unzip", "-Z1", archive],
		["tar", "-tf", archive],
	]) {
		try {
			const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
			const output = await new Response(child.stdout).text();
			if ((await child.exited) === 0)
				return output.replaceAll("\r", "").split("\n").filter(Boolean);
		} catch {
			// Try the next archive reader available on this host.
		}
	}
	throw new Error(errorMessage);
}

export async function extractZipArchive(
	archive: string,
	destination: string,
	errorMessage: string,
): Promise<void> {
	const commands =
		process.platform === "win32"
			? [
					["tar", "-xf", archive, "-C", destination],
					["unzip", "-q", archive, "-d", destination],
				]
			: [
					["unzip", "-q", archive, "-d", destination],
					["tar", "-xf", archive, "-C", destination],
				];
	for (const command of commands) {
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
		try {
			const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
			if ((await child.exited) === 0) return;
		} catch {
			// Try the next extractor available on this host.
		}
	}
	throw new Error(errorMessage);
}
