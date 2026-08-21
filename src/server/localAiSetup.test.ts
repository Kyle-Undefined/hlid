import { describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "#/config";
import {
	LOCAL_AI_SETUP_SETTING_KEY,
	type LocalAiSetupIntent,
} from "#/lib/localAiSetup";
import { createLocalAiSetupCoordinator } from "./localAiSetup";

function config(overrides: Partial<HlidConfig> = {}): HlidConfig {
	return {
		acp_agents: [{ id: "opencode", target: { kind: "wsl", distro: "Ubuntu" } }],
		ollama: { models: ["qwen3-coder:30b"], keep_warm: "5m" },
		...overrides,
	} as HlidConfig;
}

describe("local AI setup coordinator", () => {
	it("reconciles persisted intent against live runtime state", async () => {
		const saved: Record<string, string> = {
			[LOCAL_AI_SETUP_SETTING_KEY]: JSON.stringify({
				version: 1,
				startedAt: 1,
				updatedAt: 1,
				acknowledged: ["ollama"],
			} satisfies LocalAiSetupIntent),
		};
		const coordinator = createLocalAiSetupCoordinator({
			getSetting: vi.fn(async (key) => saved[key] ?? null),
			saveSetting: vi.fn(async (key, value) => {
				saved[key] = value;
			}),
			loadConfig: () => config(),
			readOllama: async () => ({
				supported: true,
				available: true,
				setupPhase: "complete",
				models: ["qwen3-coder:30b"],
				firewallReady: false,
			}),
			readOpenCode: async () => ({ available: true }),
			now: () => 10,
		});

		const snapshot = await coordinator.snapshot();
		expect(snapshot.steps.map((step) => [step.id, step.status])).toEqual([
			["ollama", "ready"],
			["opencode", "ready"],
			["models", "ready"],
			["wsl-access", "needs-action"],
		]);
		expect(snapshot.steps[0]?.acknowledged).toBe(true);
		expect(snapshot.live.models.present).toEqual(["qwen3-coder:30b"]);
	});

	it("stores only explicit workflow progress and never invokes action owners", async () => {
		const saveSetting = vi.fn(async () => {});
		const readOllama = vi.fn(async () => ({
			supported: true,
			available: false,
			setupPhase: "idle",
			models: [],
			firewallReady: null,
		}));
		const readOpenCode = vi.fn(async () => ({ available: false }));
		const coordinator = createLocalAiSetupCoordinator({
			getSetting: async () => null,
			saveSetting,
			loadConfig: () => config({ acp_agents: [], ollama: undefined }),
			readOllama,
			readOpenCode,
			now: () => 50,
		});

		await coordinator.mutate({ action: "start" });
		await coordinator.mutate({ action: "acknowledge", step: "ollama" });

		expect(saveSetting).toHaveBeenCalledWith(
			LOCAL_AI_SETUP_SETTING_KEY,
			expect.stringContaining('"acknowledged":["ollama"]'),
		);
		expect(readOllama).toHaveBeenCalled();
		expect(readOpenCode).toHaveBeenCalled();
	});
});
