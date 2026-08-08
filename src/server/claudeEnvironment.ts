import { parseWslUnc } from "../lib/paths";

function isLoopbackHttpUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === "127.0.0.1" ||
			hostname === "localhost" ||
			hostname === "[::1]"
		);
	} catch {
		return false;
	}
}

/** Base environment shared by direct Claude metadata and live queries. */
export function claudeSdkEnv(
	cwd: string,
	explicit: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> | undefined {
	if (explicit) return explicit;
	if (!parseWslUnc(cwd) || !isLoopbackHttpUrl(process.env.ANTHROPIC_BASE_URL)) {
		return undefined;
	}
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.ANTHROPIC_BASE_URL;
	return env;
}

/** Live turns additionally opt into provider lifecycle evidence. */
export function claudeLiveQueryEnv(
	base: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
	return {
		...(base ?? process.env),
		CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
	};
}
