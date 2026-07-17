import { describe, expect, it } from "vitest";
import {
	agentDisplayName,
	agentPathBasename,
	sameAgentDisplayPath,
} from "./agentDisplay";

describe("agent display identity", () => {
	it("matches WSL UNC and logical Linux paths", () => {
		expect(
			sameAgentDisplayPath(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
				"/home/kyle/project",
			),
		).toBe(true);
	});

	it("prefers the configured agent name across path forms", () => {
		expect(
			agentDisplayName(
				"\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid",
				[{ path: "/home/kyle/development/repos/hlid", name: "Hlid" }],
			),
		).toBe("Hlid");
	});

	it("uses a cross-platform basename when inventory is unavailable", () => {
		expect(agentPathBasename("C:\\repos\\hlid")).toBe("hlid");
		expect(agentPathBasename("/home/kyle/hlid/")).toBe("hlid");
	});
});
