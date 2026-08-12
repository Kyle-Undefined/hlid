import { describe, expect, it } from "vitest";
import { HlidConfigSchema } from "#/config";
import {
	acpExecutionTargetId,
	configuredAcpExecutionTarget,
	configuredAcpExecutionTargets,
} from "./acpTargets";

describe("ACP execution target catalog", () => {
	it("derives and recommends the one configured WSL distro", () => {
		const config = HlidConfigSchema.parse({
			vault: { path: "C:\\Vault" },
			agents: [
				{
					path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\project",
				},
			],
		});

		expect(configuredAcpExecutionTargets(config, "win32")).toEqual([
			expect.objectContaining({
				targetId: "host",
				target: { kind: "host" },
				label: "Windows",
				recommended: false,
			}),
			expect.objectContaining({
				targetId: acpExecutionTargetId({
					kind: "wsl",
					distro: "Ubuntu-24.04",
				}),
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
				label: "WSL · Ubuntu-24.04",
				recommended: true,
			}),
		]);
	});

	it("uses the vault distro as the recommendation when several are configured", () => {
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl$\\Ubuntu-24.04\\home\\kyle\\vault",
			},
			agents: [{ path: "\\\\wsl$\\Debian\\home\\kyle\\project" }],
		});
		const targets = configuredAcpExecutionTargets(config, "win32");

		expect(targets.filter((target) => target.recommended)).toEqual([
			expect.objectContaining({
				target: { kind: "wsl", distro: "Ubuntu-24.04" },
			}),
		]);
	});

	it("does not expose WSL targets to a non-Windows host", () => {
		const config = HlidConfigSchema.parse({
			vault: { path: "\\\\wsl$\\Ubuntu\\home\\kyle\\vault" },
		});
		expect(configuredAcpExecutionTargets(config, "linux")).toEqual([
			expect.objectContaining({
				targetId: "host",
				label: "Host",
				recommended: true,
			}),
		]);
	});

	it("fails closed for browser target IDs that are not configured", () => {
		const config = HlidConfigSchema.parse({});
		expect(configuredAcpExecutionTarget(config, "wsl-attacker", "win32")).toBe(
			null,
		);
	});

	it("does not expose an invalid WSL distro name as an install target", () => {
		const config = HlidConfigSchema.parse({
			vault: {
				path: "\\\\wsl.localhost\\Ubuntu;unexpected\\home\\kyle\\vault",
			},
		});
		expect(configuredAcpExecutionTargets(config, "win32")).toEqual([
			expect.objectContaining({ targetId: "host", target: { kind: "host" } }),
		]);
	});
});
