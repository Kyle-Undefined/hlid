import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSetting, saveSetting } = vi.hoisted(() => ({
	getSetting: vi.fn(),
	saveSetting: vi.fn(),
}));

vi.mock("../db/settings", () => ({ getSetting, saveSetting }));

import {
	ACP_TARGET_PLATFORM_EVIDENCE_MAX_AGE_MS,
	ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY,
	loadAcpTargetPlatformEvidence,
	saveAcpTargetPlatformEvidence,
} from "./acpPlatformEvidence";
import { acpExecutionTargetId } from "./acpTargets";

const targetKey = "wsl:ubuntu-24.04";
const targetId = acpExecutionTargetId({
	kind: "wsl",
	distro: "Ubuntu-24.04",
});

beforeEach(() => {
	vi.clearAllMocks();
	getSetting.mockResolvedValue(null);
	saveSetting.mockResolvedValue(undefined);
});

describe("ACP target platform evidence persistence", () => {
	it("loads only current evidence for the exact target key and id", async () => {
		const now = 10_000;
		const evidence = {
			targetKey,
			targetId,
			platform: "linux" as const,
			architecture: "x64" as const,
			observedAt: now - 1,
		};
		getSetting.mockResolvedValue(
			JSON.stringify({ version: 1, entries: [evidence] }),
		);

		await expect(
			loadAcpTargetPlatformEvidence({ targetKey, targetId, now }),
		).resolves.toEqual(evidence);
		await expect(
			loadAcpTargetPlatformEvidence({
				targetKey: "wsl:debian",
				targetId: acpExecutionTargetId({ kind: "wsl", distro: "Debian" }),
				now,
			}),
		).resolves.toBeNull();
	});

	it("rejects expired, future, mismatched, and oversized persisted data", async () => {
		const now = ACP_TARGET_PLATFORM_EVIDENCE_MAX_AGE_MS + 1_000;
		const read = () =>
			loadAcpTargetPlatformEvidence({ targetKey, targetId, now });
		const base = {
			targetKey,
			targetId,
			platform: "linux",
			architecture: "x64",
			observedAt: 999,
		};

		getSetting.mockResolvedValue(
			JSON.stringify({ version: 1, entries: [base] }),
		);
		await expect(read()).resolves.toBeNull();
		getSetting.mockResolvedValue(
			JSON.stringify({
				version: 1,
				entries: [{ ...base, observedAt: now + 1 }],
			}),
		);
		await expect(read()).resolves.toBeNull();
		getSetting.mockResolvedValue(
			JSON.stringify({
				version: 1,
				entries: [
					{ ...base, observedAt: now, targetId: "wsl-0000000000000000" },
				],
			}),
		);
		await expect(read()).resolves.toBeNull();
		getSetting.mockResolvedValue("x".repeat(16 * 1024 + 1));
		await expect(read()).resolves.toBeNull();
	});

	it("serializes successful writes without dropping evidence for another target", async () => {
		let persisted: string | null = null;
		getSetting.mockImplementation(async () => persisted);
		saveSetting.mockImplementation(async (_key: string, value: string) => {
			await Promise.resolve();
			persisted = value;
		});
		const debianKey = "wsl:debian";
		const debianId = acpExecutionTargetId({ kind: "wsl", distro: "Debian" });

		await Promise.all([
			saveAcpTargetPlatformEvidence({
				targetKey,
				targetId,
				platform: "linux",
				architecture: "x64",
				observedAt: 1_000,
			}),
			saveAcpTargetPlatformEvidence({
				targetKey: debianKey,
				targetId: debianId,
				platform: "linux",
				architecture: "arm64",
				observedAt: 1_001,
			}),
		]);

		expect(saveSetting).toHaveBeenCalledTimes(2);
		expect(saveSetting).toHaveBeenLastCalledWith(
			ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY,
			expect.any(String),
		);
		expect(JSON.parse(persisted ?? "{}")).toEqual({
			version: 1,
			entries: [
				expect.objectContaining({ targetKey: debianKey, targetId: debianId }),
				expect.objectContaining({ targetKey, targetId }),
			],
		});
	});

	it("does not overwrite other evidence when the current setting cannot be read", async () => {
		getSetting.mockRejectedValue(new Error("database unavailable"));

		await expect(
			saveAcpTargetPlatformEvidence({
				targetKey,
				targetId,
				platform: "linux",
				architecture: "x64",
				observedAt: 1_000,
			}),
		).rejects.toThrow("database unavailable");
		expect(saveSetting).not.toHaveBeenCalled();
	});
});
