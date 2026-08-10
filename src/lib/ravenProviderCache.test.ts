import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_DATA_REVISIONS,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "#/hooks/wsDataRevisionStore";
import { getProvidersFn } from "#/lib/serverFns/providers";
import {
	loadRavenProviders,
	loadRavenProvidersForNavigation,
	refreshRavenProvider,
	refreshRavenProviderForSession,
	resetRavenProviderCacheForTesting,
} from "./ravenProviderCache";

vi.mock("#/lib/serverFns/providers", () => ({
	getProvidersFn: vi.fn(),
}));

const provider = (model: string) => [
	{
		id: "acp:opencode",
		label: "OpenCode",
		available: true,
		models: [{ value: model, label: model }],
	},
];

const refreshedProvider = (
	model: string,
	status: "current" | "stale",
	revision?: number,
) => [
	{
		...provider(model)[0],
		modelCatalogRefresh: {
			status,
			source: status === "current" ? ("live" as const) : ("memory" as const),
			...(revision === undefined ? {} : { revision }),
		},
	},
];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	resetRavenProviderCacheForTesting();
	resetDataRevisionsForTesting();
});

describe("loadRavenProviders", () => {
	it("shares and reuses the cache within one provider revision", async () => {
		vi.mocked(getProvidersFn).mockResolvedValue(provider("one"));

		const first = loadRavenProviders();
		const second = loadRavenProviders();

		expect(await first).toEqual(provider("one"));
		expect(await second).toEqual(provider("one"));
		expect(await loadRavenProviders()).toEqual(provider("one"));
		expect(getProvidersFn).toHaveBeenCalledOnce();
	});

	it("reloads immediately when the provider revision changes", async () => {
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(provider("old"))
			.mockResolvedValueOnce(provider("new"));
		expect(await loadRavenProviders()).toEqual(provider("old"));

		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });

		expect(await loadRavenProviders()).toEqual(provider("new"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("keeps the cache when only an unrelated revision changes", async () => {
		vi.mocked(getProvidersFn).mockResolvedValue(provider("one"));
		expect(await loadRavenProviders()).toEqual(provider("one"));

		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, sessions: 1 });

		expect(await loadRavenProviders()).toEqual(provider("one"));
		expect(getProvidersFn).toHaveBeenCalledOnce();
	});

	it("isolates provider reads by normalized discovery workspace", async () => {
		vi.mocked(getProvidersFn).mockImplementation((input) => {
			const data = (input as { data?: { discoveryCwd?: string } }).data;
			return Promise.resolve(provider(data?.discoveryCwd ?? "default"));
		});

		expect(await loadRavenProviders("C:\\Users\\Kyle\\One\\")).toEqual(
			provider("C:\\Users\\Kyle\\One\\"),
		);
		expect(await loadRavenProviders("/workspace/two")).toEqual(
			provider("/workspace/two"),
		);
		expect(await loadRavenProviders("c:\\users\\kyle\\one")).toEqual(
			provider("C:\\Users\\Kyle\\One\\"),
		);

		expect(getProvidersFn).toHaveBeenCalledTimes(2);
		expect(getProvidersFn).toHaveBeenNthCalledWith(1, {
			data: {
				preferCachedModels: true,
				discoveryCwd: "C:\\Users\\Kyle\\One\\",
			},
		});
		expect(getProvidersFn).toHaveBeenNthCalledWith(2, {
			data: {
				preferCachedModels: true,
				discoveryCwd: "/workspace/two",
			},
		});
	});

	it("does not let an older revision overwrite or clear the newer read", async () => {
		let resolveOld: ((value: ReturnType<typeof provider>) => void) | undefined;
		let resolveNew: ((value: ReturnType<typeof provider>) => void) | undefined;
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNew = resolve;
					}),
			);

		const oldRead = loadRavenProviders();
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });
		const newRead = loadRavenProviders();
		resolveNew?.(provider("new"));
		expect(await newRead).toEqual(provider("new"));
		resolveOld?.(provider("old"));
		expect(await oldRead).toEqual(provider("old"));

		expect(await loadRavenProviders()).toEqual(provider("new"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("bypasses an unexpired cache with a provider-scoped live refresh", async () => {
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(provider("cached"))
			.mockResolvedValueOnce(provider("live"));

		expect(await loadRavenProviders("/vault")).toEqual(provider("cached"));
		expect(await refreshRavenProvider("acp:opencode", "/vault")).toEqual(
			provider("live"),
		);
		expect(await loadRavenProviders("/vault")).toEqual(provider("live"));

		expect(getProvidersFn).toHaveBeenCalledTimes(2);
		expect(getProvidersFn).toHaveBeenNthCalledWith(2, {
			data: {
				refresh: true,
				refreshProviderId: "acp:opencode",
				discoveryCwd: "/vault",
			},
		});
	});

	it("joins a live refresh across a revision change, then rematerializes that revision", async () => {
		const liveRefresh = deferred<ReturnType<typeof provider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => liveRefresh.promise)
			.mockResolvedValueOnce(provider("rematerialized"));

		const refreshing = refreshRavenProvider("acp:opencode", "/vault");
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });
		const joined = loadRavenProviders("/vault");

		expect(joined).toBe(refreshing);
		liveRefresh.resolve(provider("fresh"));
		const stale = await refreshing;
		expect(stale).toEqual([
			expect.objectContaining({
				models: [{ value: "fresh", label: "fresh" }],
				modelCatalogRefresh: {
					status: "stale",
					source: "fallback",
					reason:
						"Provider configuration changed during live refresh; retry for current metadata.",
				},
			}),
		]);
		expect(await joined).toEqual(stale);

		// The live response started under revision 0, so it must not be cached as
		// revision 1. The next ordinary read rematerializes the server snapshot.
		expect(await loadRavenProviders("/vault")).toEqual(
			provider("rematerialized"),
		);
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
		expect(getProvidersFn).toHaveBeenNthCalledWith(2, {
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});
	});

	it("does not let an older ordinary success overwrite a live refresh", async () => {
		const staleRead = deferred<ReturnType<typeof provider>>();
		const liveRefresh = deferred<ReturnType<typeof provider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => staleRead.promise)
			.mockImplementationOnce(() => liveRefresh.promise);

		const stale = loadRavenProviders("/vault");
		const refreshing = refreshRavenProvider("acp:opencode", "/vault");
		liveRefresh.resolve(provider("fresh"));
		expect(await refreshing).toEqual(provider("fresh"));

		staleRead.resolve(provider("stale"));
		expect(await stale).toEqual(provider("stale"));
		expect(await loadRavenProviders("/vault")).toEqual(provider("fresh"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("does not let an older ordinary rejection delete a live refresh", async () => {
		const staleRead = deferred<ReturnType<typeof provider>>();
		const liveRefresh = deferred<ReturnType<typeof provider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => staleRead.promise)
			.mockImplementationOnce(() => liveRefresh.promise);

		const stale = loadRavenProviders("/vault");
		const staleRejection = expect(stale).rejects.toThrow("stale read failed");
		const refreshing = refreshRavenProvider("acp:opencode", "/vault");
		liveRefresh.resolve(provider("fresh"));
		expect(await refreshing).toEqual(provider("fresh"));

		staleRead.reject(new Error("stale read failed"));
		await staleRejection;
		expect(await loadRavenProviders("/vault")).toEqual(provider("fresh"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("returns a valid prior cache without joining an active live refresh", async () => {
		const liveRefresh = deferred<ReturnType<typeof provider>>();
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(provider("cached"))
			.mockImplementationOnce(() => liveRefresh.promise);

		expect(await loadRavenProviders("/vault")).toEqual(provider("cached"));
		const refreshing = refreshRavenProvider("acp:opencode", "/vault");
		const navigation = loadRavenProvidersForNavigation("/vault");

		expect(navigation).not.toBe(refreshing);
		expect(await navigation).toEqual(provider("cached"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);

		liveRefresh.resolve(provider("live"));
		expect(await refreshing).toEqual(provider("live"));
	});

	it("keeps a process-free navigation read separate from an active refresh", async () => {
		const liveRefresh = deferred<ReturnType<typeof provider>>();
		const navigationRead = deferred<ReturnType<typeof provider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => liveRefresh.promise)
			.mockImplementationOnce(() => navigationRead.promise);

		const refreshing = refreshRavenProvider("acp:opencode", "/vault");
		const navigation = loadRavenProvidersForNavigation("/vault");
		const sharedNavigation = loadRavenProvidersForNavigation("/vault");

		expect(navigation).not.toBe(refreshing);
		expect(sharedNavigation).toBe(navigation);
		expect(getProvidersFn).toHaveBeenNthCalledWith(2, {
			data: { preferCachedModels: true, discoveryCwd: "/vault" },
		});

		liveRefresh.resolve(provider("live"));
		expect(await refreshing).toEqual(provider("live"));
		navigationRead.resolve(provider("cached"));
		expect(await navigation).toEqual(provider("cached"));
		expect(await loadRavenProviders("/vault")).toEqual(provider("live"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("preserves the prior safe catalog when live refresh fails", async () => {
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(provider("cached"))
			.mockRejectedValueOnce(new Error("live refresh failed"));

		expect(await loadRavenProviders("/vault")).toEqual(provider("cached"));
		const fallback = await refreshRavenProvider("acp:opencode", "/vault");
		expect(fallback).toEqual([
			expect.objectContaining({
				id: "acp:opencode",
				models: [{ value: "cached", label: "cached" }],
				modelCatalogRefresh: {
					status: "stale",
					source: "memory",
					reason: "Live refresh failed; using cached provider metadata.",
				},
			}),
		]);
		expect(await loadRavenProviders("/vault")).toEqual(fallback);
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("shares one current live refresh for the same unsaved session", async () => {
		vi.mocked(getProvidersFn).mockResolvedValue(
			refreshedProvider("allowed", "current"),
		);

		const first = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);
		const second = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);

		expect(second).toBe(first);
		expect(await first).toEqual(refreshedProvider("allowed", "current"));
		expect(getProvidersFn).toHaveBeenCalledOnce();
	});

	it("refreshes the same unsaved session after the provider revision changes", async () => {
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(refreshedProvider("old", "current"))
			.mockResolvedValueOnce(refreshedProvider("new", "current"));

		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("old", "current"));

		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });

		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("new", "current"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("memoizes the server revision produced by a live refresh, then retries after a later revision", async () => {
		const oldRefresh = deferred<ReturnType<typeof refreshedProvider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => oldRefresh.promise)
			.mockResolvedValueOnce(refreshedProvider("new", "current", 2));

		const first = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });
		const joined = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);

		expect(joined).toBe(first);
		oldRefresh.resolve(refreshedProvider("old", "current", 1));
		expect(await joined).toEqual(refreshedProvider("old", "current", 1));

		const memoized = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);
		expect(memoized).toBe(first);
		expect(await memoized).toEqual(refreshedProvider("old", "current", 1));
		expect(getProvidersFn).toHaveBeenCalledOnce();

		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 2 });
		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("new", "current", 2));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("does not memoize a response older than an external in-flight revision", async () => {
		const oldRefresh = deferred<ReturnType<typeof refreshedProvider>>();
		vi.mocked(getProvidersFn)
			.mockImplementationOnce(() => oldRefresh.promise)
			.mockResolvedValueOnce(refreshedProvider("new", "current", 1));

		const first = refreshRavenProviderForSession(
			"new-session",
			"acp:opencode",
			"/vault",
		);
		replaceDataRevisions({ ...EMPTY_DATA_REVISIONS, providers: 1 });
		oldRefresh.resolve(refreshedProvider("old", "current", 0));
		expect(await first).toEqual([
			expect.objectContaining({
				models: [{ value: "old", label: "old" }],
				modelCatalogRefresh: expect.objectContaining({ status: "stale" }),
			}),
		]);

		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("new", "current", 1));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});

	it("retries an unsaved session after a stale refresh result", async () => {
		vi.mocked(getProvidersFn)
			.mockResolvedValueOnce(refreshedProvider("stale", "stale"))
			.mockResolvedValueOnce(refreshedProvider("allowed", "current"));

		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("stale", "stale"));
		expect(
			await refreshRavenProviderForSession(
				"new-session",
				"acp:opencode",
				"/vault",
			),
		).toEqual(refreshedProvider("allowed", "current"));
		expect(getProvidersFn).toHaveBeenCalledTimes(2);
	});
});
