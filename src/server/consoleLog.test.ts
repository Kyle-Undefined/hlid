import { describe, expect, it } from "vitest";
import { formatPersistentConsoleMessage } from "./consoleLog";

describe("formatPersistentConsoleMessage", () => {
	it("preserves cross-realm error messages and stacks", () => {
		expect(
			formatPersistentConsoleMessage("error", [
				{
					name: "TypeError",
					message: "bad render",
					stack: "at render (app.ts:1)",
				},
			]),
		).toBe("TypeError: bad render\nat render (app.ts:1)");
	});

	it("labels otherwise anonymous server stacks", () => {
		expect(
			formatPersistentConsoleMessage("error", [
				"@bundle/index.js:42\n$renderToReadableStream@bundle/index.js:12",
			]),
		).toContain("Unhandled server error:");
	});

	it("does not serialize arbitrary objects into the persistent log", () => {
		expect(
			formatPersistentConsoleMessage("warn", [{ token: "do-not-store" }]),
		).toBe("[Object]");
	});
});
