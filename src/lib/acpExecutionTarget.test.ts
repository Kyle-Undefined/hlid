import { describe, expect, it } from "vitest";
import {
	AcpExecutionTargetSchema,
	acpExecutionTargetKey,
	acpExecutionTargetLabel,
	normalizeAcpExecutionTarget,
} from "./acpExecutionTarget";

describe("ACP execution targets", () => {
	it("normalizes the legacy absent target to the host", () => {
		expect(normalizeAcpExecutionTarget(undefined)).toEqual({ kind: "host" });
		expect(acpExecutionTargetKey(undefined)).toBe("host");
		expect(acpExecutionTargetLabel(undefined)).toBe("Windows");
	});

	it("uses a case-insensitive WSL identity and a display-preserving label", () => {
		const target = { kind: "wsl", distro: "Ubuntu-24.04" } as const;
		expect(acpExecutionTargetKey(target)).toBe("wsl:ubuntu-24.04");
		expect(acpExecutionTargetLabel(target)).toBe("WSL · Ubuntu-24.04");
	});

	it("rejects distro names that could change wsl.exe arguments", () => {
		expect(
			AcpExecutionTargetSchema.safeParse({
				kind: "wsl",
				distro: 'Ubuntu" --exec calc',
			}).success,
		).toBe(false);
	});
});
