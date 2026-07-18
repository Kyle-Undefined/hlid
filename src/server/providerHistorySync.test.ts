import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPlanProviderHistoryImport } = vi.hoisted(() => ({
	mockPlanProviderHistoryImport: vi.fn(),
}));

vi.mock("#/db", () => ({
	getDb: vi.fn().mockResolvedValue({}),
}));

vi.mock("#/db/providerHistoryImport", () => ({
	discoverClaudeHistoryRoots: vi.fn().mockResolvedValue([]),
	discoverCodexHistoryRoots: vi.fn().mockResolvedValue([]),
	planProviderHistoryImport: mockPlanProviderHistoryImport,
	applyProviderHistoryImport: vi.fn(),
}));

vi.mock("./config", () => ({ loadConfig: vi.fn() }));
vi.mock("./dataRevision", () => ({ bumpDataRevision: vi.fn() }));

function emptyManifest() {
	return {
		sessions: [],
		totals: { queries: 0 },
		skipped: [],
	};
}

describe("provider history background sync", () => {
	beforeEach(() => {
		vi.resetModules();
		mockPlanProviderHistoryImport.mockReset();
	});

	it("reuses a running job and exposes its completed result", async () => {
		let finishPlanning!: (manifest: ReturnType<typeof emptyManifest>) => void;
		mockPlanProviderHistoryImport.mockReturnValueOnce(
			new Promise((resolve) => {
				finishPlanning = resolve;
			}),
		);
		const { getProviderHistorySyncStatus, startProviderHistorySync } =
			await import("./providerHistorySync");

		const first = startProviderHistorySync();
		const second = startProviderHistorySync();
		expect(first).toMatchObject({ state: "running" });
		expect(second).toEqual(first);
		await vi.waitFor(() => {
			expect(mockPlanProviderHistoryImport).toHaveBeenCalledTimes(1);
		});

		finishPlanning(emptyManifest());
		await vi.waitFor(() => {
			expect(
				getProviderHistorySyncStatus(first.jobId ?? undefined),
			).toMatchObject({
				state: "completed",
				jobId: first.jobId,
				result: { plannedSessions: 0, insertedQueries: 0 },
			});
		});
	});

	it("retains a failed job for status polling", async () => {
		mockPlanProviderHistoryImport.mockRejectedValueOnce(
			new Error("history root became unavailable"),
		);
		const { getProviderHistorySyncStatus, startProviderHistorySync } =
			await import("./providerHistorySync");

		const started = startProviderHistorySync();
		await vi.waitFor(() => {
			expect(
				getProviderHistorySyncStatus(started.jobId ?? undefined),
			).toMatchObject({
				state: "failed",
				jobId: started.jobId,
				error: "history root became unavailable",
			});
		});
	});
});
