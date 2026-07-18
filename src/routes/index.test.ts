import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn().mockResolvedValue({}),
	getCockpitData: vi.fn().mockResolvedValue({ skills: [], projects: [] }),
	getRecentSessionsFn: vi.fn().mockResolvedValue([]),
	getCockpitStatsFn: vi.fn().mockResolvedValue({ agg: {} }),
	getMcpServersFn: vi.fn().mockResolvedValue([]),
	getWeeklyStatsFn: vi.fn().mockResolvedValue({ days: [], total: 0 }),
	loadProviderUsages: vi.fn(() => new Promise(() => {})),
	getThirtyDayStatsFn: vi.fn().mockResolvedValue({ days: [], total: 0 }),
	getAgentListFn: vi.fn().mockResolvedValue([]),
	getActiveSessionRowFn: vi.fn().mockResolvedValue(null),
	getVoiceInfoFn: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => options,
	useNavigate: vi.fn(),
	useRouter: vi.fn(),
}));

vi.mock("#/lib/serverFns/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("#/lib/serverFns/cockpit", () => ({
	getCockpitData: mocks.getCockpitData,
}));
vi.mock("#/lib/serverFns/agents", () => ({
	getAgentListFn: mocks.getAgentListFn,
}));
vi.mock("#/lib/serverFns/mcp", () => ({
	getMcpServersFn: mocks.getMcpServersFn,
}));
vi.mock("#/lib/serverFns/providers", () => ({
	loadProviderUsages: mocks.loadProviderUsages,
}));
vi.mock("#/lib/serverFns/sessions", () => ({
	getActiveSessionRowFn: mocks.getActiveSessionRowFn,
}));
vi.mock("#/lib/serverFns/stats", () => ({
	getCockpitStatsFn: mocks.getCockpitStatsFn,
	getRecentSessionsFn: mocks.getRecentSessionsFn,
	getThirtyDayStatsFn: mocks.getThirtyDayStatsFn,
	getWeeklyStatsFn: mocks.getWeeklyStatsFn,
}));
vi.mock("#/lib/serverFns/voice", () => ({
	getVoiceInfoFn: mocks.getVoiceInfoFn,
}));

import {
	cacheCockpitOptionalData,
	clearCockpitOptionalDataCacheForTesting,
	preserveCockpitDataDuringFallback,
	Route,
	restoreCachedCockpitOptionalData,
} from "./index";

describe("Watch route loader", () => {
	it("restores the last complete dashboard snapshot across navigation", () => {
		vi.stubGlobal("window", {});
		try {
			const populated = {
				weeklyStats: { total: 8 },
				thirtyDayStats: { total: 21 },
			} as never;
			const fallback = {
				weeklyStats: { total: 0 },
				thirtyDayStats: { total: 0 },
			} as never;

			cacheCockpitOptionalData(populated);
			expect(restoreCachedCockpitOptionalData(fallback)).toBe(populated);
		} finally {
			clearCockpitOptionalDataCacheForTesting();
			vi.unstubAllGlobals();
		}
	});

	it("keeps populated dashboard data while a loader fallback recovers", () => {
		const populated = { thirtyDayTotal: 14, weeklyTotal: 5 };
		const emptyFallback = { thirtyDayTotal: 0, weeklyTotal: 0 };

		expect(
			preserveCockpitDataDuringFallback(
				populated,
				emptyFallback,
				"unavailable",
			),
		).toBe(populated);
		expect(
			preserveCockpitDataDuringFallback(populated, emptyFallback, "ready"),
		).toBe(emptyFallback);
	});

	it("does not hold navigation behind provider discovery", async () => {
		const loader = (Route as unknown as { loader: () => Promise<unknown> })
			.loader;
		const loaded = await loader();

		expect(loaded).toMatchObject({
			providerUsages: [
				expect.objectContaining({ providerId: "claude" }),
				expect.objectContaining({ providerId: "codex" }),
			],
		});
		expect(mocks.loadProviderUsages).not.toHaveBeenCalled();
	});

	it("falls back inside the navigation budget when optional data stalls", async () => {
		vi.useFakeTimers();
		try {
			mocks.getMcpServersFn.mockReturnValueOnce(new Promise(() => {}));
			const loader = (Route as unknown as { loader: () => Promise<unknown> })
				.loader;
			const pending = loader();
			await vi.advanceTimersByTimeAsync(500);
			await expect(pending).resolves.toMatchObject({
				mcpServers: [],
				optionalDataStatus: "unavailable",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
