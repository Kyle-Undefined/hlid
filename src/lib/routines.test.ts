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
	notificationPolicy: {
		success: "default" as const,
		actionRequired: "default" as const,
		failure: "default" as const,
		targets: { kind: "all" as const },
	},
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

	it("backfills the legacy notification policy and validates exact targets", () => {
		const { notificationPolicy: _notificationPolicy, ...legacy } = base;
		const parsed = routineDefinitionSchema.parse({
			...legacy,
			prompt: "Review the project",
		});
		expect(parsed.notificationPolicy).toEqual({
			success: "default",
			actionRequired: "default",
			failure: "default",
			targets: { kind: "all" },
		});

		const deviceId = "11111111-1111-4111-8111-111111111111";
		expect(
			routineDefinitionSchema.safeParse({
				...base,
				prompt: "Review the project",
				notificationPolicy: {
					success: "notify",
					actionRequired: "mute",
					failure: "default",
					targets: { kind: "devices", deviceIds: [deviceId] },
				},
			}).success,
		).toBe(true);
		expect(
			routineDefinitionSchema.safeParse({
				...base,
				prompt: "Review the project",
				notificationPolicy: {
					...base.notificationPolicy,
					targets: { kind: "devices", deviceIds: [deviceId, deviceId] },
				},
			}).success,
		).toBe(false);
	});
});
