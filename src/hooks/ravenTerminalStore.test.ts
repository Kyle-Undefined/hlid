// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
	forgetRavenTerminal,
	isRavenTerminalOpen,
	rememberRavenTerminal,
	resetRavenTerminalsForTesting,
} from "./ravenTerminalStore";

describe("ravenTerminalStore", () => {
	beforeEach(resetRavenTerminalsForTesting);

	it("remembers open terminals independently for each Raven session", () => {
		rememberRavenTerminal("session-a");
		rememberRavenTerminal("session-b");

		expect(isRavenTerminalOpen("session-a")).toBe(true);
		expect(isRavenTerminalOpen("session-b")).toBe(true);
		expect(isRavenTerminalOpen("session-c")).toBe(false);
	});

	it("forgets only the closed terminal", () => {
		rememberRavenTerminal("session-a");
		rememberRavenTerminal("session-b");

		forgetRavenTerminal("session-a");

		expect(isRavenTerminalOpen("session-a")).toBe(false);
		expect(isRavenTerminalOpen("session-b")).toBe(true);
	});

	it("ignores invalid session ids", () => {
		rememberRavenTerminal("");

		expect(isRavenTerminalOpen("")).toBe(false);
	});
});
