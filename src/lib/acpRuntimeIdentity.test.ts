import { describe, expect, it } from "vitest";
import { acpRuntimeIdentity } from "./acpRuntimeIdentity";

describe("acpRuntimeIdentity", () => {
	it("is stable across agent and environment-key order", () => {
		const first = acpRuntimeIdentity([
			{ id: "pi-acp", env: { ZED: "1", ALPHA: "2" } },
			{ id: "opencode", executable: "opencode.cmd", args: ["acp"] },
		]);
		const second = acpRuntimeIdentity([
			{ id: "opencode", executable: "opencode.cmd", args: ["acp"] },
			{ id: "pi-acp", env: { ALPHA: "2", ZED: "1" } },
		]);

		expect(first).toBe(second);
	});

	it("ignores defaults that do not replace the ACP subprocess", () => {
		expect(
			acpRuntimeIdentity([
				{
					id: "opencode",
					model: "provider/model-a",
					effort: "high",
					permission_mode: "default",
					turn_recaps: true,
				},
			]),
		).toBe(acpRuntimeIdentity([{ id: "opencode" }]));
	});
});
