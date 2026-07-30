import { resolveDevServerPort } from "../src/lib/devServerPort";

function requestedPort(args: string[]): string | undefined {
	const equalsArg = args.find((arg) => arg.startsWith("--port="));
	if (equalsArg) return equalsArg.slice("--port=".length);
	const index = args.indexOf("--port");
	if (index >= 0) return args[index + 1];
	return process.env.HLID_DEV_PORT;
}

const rawPort = requestedPort(process.argv.slice(2));
if (!rawPort) {
	throw new Error(
		"dev:preview requires --port <number> (for example: bun run dev:preview -- --port 4177)",
	);
}
const port = resolveDevServerPort(3000, rawPort);

console.log(
	`Starting Hlid Project Preview UI on http://127.0.0.1:${port} with API/WebSocket server on ${port + 1}`,
);

const child = Bun.spawn([process.execPath, "--bun", "run", "dev:all"], {
	cwd: process.cwd(),
	env: { ...process.env, HLID_DEV_PORT: String(port) },
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

let stopping = false;
function stop(signal: "SIGINT" | "SIGTERM") {
	if (stopping) return;
	stopping = true;
	child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

process.exitCode = await child.exited;
