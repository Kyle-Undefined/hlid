import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_DATA_REVISIONS,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "#/hooks/wsDataRevisionStore";
import { getProvidersFn } from "#/lib/serverFns/providers";
import {
	loadRavenProviders,
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
});
