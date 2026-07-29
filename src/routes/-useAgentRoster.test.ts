import { describe, expect, it } from "vitest";
import type { AgentEntry } from "#/components/einherjar/AgentCard";
import { sortAgentEntries } from "./-useAgentRoster";

function agent(name: string, path = `/agents/${name}`): AgentEntry {
	return {
		name,
		path,
		mode: "cwd",
		provider: "claude",
		instructionFile: null,
		dirExists: true,
	};
}

describe("sortAgentEntries", () => {
	it("orders Einherjar by display name without changing the source array", () => {
		const source = [
			agent("Zulu"),
			agent("alpha"),
			agent("Charlie"),
			agent("bravo"),
		];

		const sorted = sortAgentEntries(source);

		expect(sorted.map((entry) => entry.name)).toEqual([
			"alpha",
			"bravo",
			"Charlie",
			"Zulu",
		]);
		expect(source.map((entry) => entry.name)).toEqual([
			"Zulu",
			"alpha",
			"Charlie",
			"bravo",
		]);
	});

	it("uses the path as a stable tie-breaker for matching names", () => {
		const sorted = sortAgentEntries([
			agent("Forge", "/work/zeta"),
			agent("forge", "/work/alpha"),
		]);

		expect(sorted.map((entry) => entry.path)).toEqual([
			"/work/alpha",
			"/work/zeta",
		]);
	});
});
