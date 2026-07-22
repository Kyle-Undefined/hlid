import { describe, expect, it } from "vitest";
import { routineDefinitionSchema } from "./routines";

const base = {
	name: "Weekly review",
	prompt: "",
	enabled: false,
	schedule: { kind: "daily" as const, time: "09:00" },
	timezone: "America/New_York",
	providerId: "claude",
	model: "",
	effort: "",
	agentCwd: "C:/Vault",
	agentName: "Fornbok",
	skillContexts: [],
	providerCommands: [],
	vaultReferences: [],
	relicIds: [],
	permissionMode: "read_only" as const,
	grants: [],
	deliveries: [],
	catchUpWindowMinutes: 360,
	noOverlap: true,
};

describe("routineDefinitionSchema", () => {
	it("requires a prompt or at least one selected skill", () => {
		expect(routineDefinitionSchema.safeParse(base).success).toBe(false);
		expect(
			routineDefinitionSchema.safeParse({
				...base,
				skillContexts: ["C:/Vault/Skills/review.md"],
			}).success,
		).toBe(true);
		expect(
			routineDefinitionSchema.safeParse({
				...base,
				providerCommands: ["research"],
			}).success,
		).toBe(true);
	});
});
