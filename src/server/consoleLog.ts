type ConsoleLevel = "info" | "warn" | "error";

function formatConsoleArg(value: unknown): string {
	if (value instanceof Error)
		return value.stack ?? `${value.name}: ${value.message}`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const message = typeof record.message === "string" ? record.message : "";
		const name = typeof record.name === "string" ? record.name : "Error";
		const stack = typeof record.stack === "string" ? record.stack : "";
		if (message) {
			const label = `${name}: ${message}`;
			return stack.includes(message)
				? stack
				: `${label}${stack ? `\n${stack}` : ""}`;
		}
		if (typeof record.componentStack === "string") {
			return `React component stack:${record.componentStack}`;
		}
		// Console objects can contain request bodies, tokens, or tool output. Do
		// not serialize an arbitrary object into the persistent event log.
		return `[${value.constructor?.name ?? "Object"}]`;
	}
	return String(value);
}

export function formatPersistentConsoleMessage(
	level: ConsoleLevel,
	args: unknown[],
): string {
	const message = args.map(formatConsoleArg).join(" ").trim();
	if (message) {
		return level === "error" && !/^[A-Za-z][^:\n]{0,80}:/.test(message)
			? `Unhandled server error:\n${message}`
			: message;
	}
	return level === "error" ? "Unhandled server error" : "";
}
