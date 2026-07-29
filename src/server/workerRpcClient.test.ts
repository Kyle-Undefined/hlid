import type { Manifest } from "@umbod/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

type FakeWorkerListener = (event: unknown) => void;

class FakeWorker {
	static instances: FakeWorker[] = [];

	readonly postMessage = vi.fn();
	readonly terminate = vi.fn();
	private readonly listeners = new Map<string, FakeWorkerListener[]>();

	constructor(
		readonly url: string,
		readonly options: unknown,
	) {
		FakeWorker.instances.push(this);
	}

	addEventListener(type: string, listener: FakeWorkerListener): void {
		const listeners = this.listeners.get(type);
		if (listeners) listeners.push(listener);
		else this.listeners.set(type, [listener]);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function postedRequest(worker: FakeWorker, index = 0): Record<string, unknown> {
	return worker.postMessage.mock.calls[index]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
	vi.resetModules();
	FakeWorker.instances = [];
	vi.stubGlobal("Worker", FakeWorker);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:worker");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("worker RPC clients", () => {
	it("adapts Umbod responses, reuses its worker, and preserves invalidation", async () => {
		const { invalidateUmbodAnalytics, readUmbodCalls } = await import(
			"./umbodAnalyticsWorkerClient"
		);
		const manifest = {} as Manifest;
		const first = readUmbodCalls(
			manifest,
			"C:\\data\\hlid.db",
			new URLSearchParams({ search: "allow" }),
		);
		const worker = FakeWorker.instances[0];
		expect(worker?.options).toEqual({ type: "module", smol: true, ref: false });
		const firstRequest = postedRequest(worker);
		expect(firstRequest).toMatchObject({
			kind: "calls",
			manifest,
			databasePath: "C:\\data\\hlid.db",
			searchParams: "search=allow",
		});
		worker.emit("message", {
			data: { id: firstRequest.id, result: { rows: [1] } },
		});
		await expect(first).resolves.toEqual({ rows: [1] });

		const second = readUmbodCalls(
			manifest,
			"C:\\data\\hlid.db",
			new URLSearchParams(),
		);
		expect(FakeWorker.instances).toHaveLength(1);
		const secondRequest = postedRequest(worker, 1);
		worker.emit("message", {
			data: { id: secondRequest.id, error: "Umbod query failed" },
		});
		await expect(second).rejects.toThrow("Umbod query failed");

		invalidateUmbodAnalytics();
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it("preserves Umbod timeout and worker failure messages", async () => {
		vi.useFakeTimers();
		const { invalidateUmbodAnalytics, readUmbodCalls } = await import(
			"./umbodAnalyticsWorkerClient"
		);
		const timedOut = readUmbodCalls(
			{} as Manifest,
			"C:\\data\\hlid.db",
			new URLSearchParams(),
		);
		const timeoutExpectation = expect(timedOut).rejects.toThrow(
			"Umbod analytics worker timed out after 30000ms",
		);
		await vi.advanceTimersByTimeAsync(30_000);
		await timeoutExpectation;
		expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();

		const failed = readUmbodCalls(
			{} as Manifest,
			"C:\\data\\hlid.db",
			new URLSearchParams(),
		);
		const failedWorker = FakeWorker.instances[1];
		failedWorker.emit("error", { message: " native crash " });
		await expect(failed).rejects.toThrow(
			"Umbod analytics worker failed: native crash",
		);
		expect(failedWorker.terminate).toHaveBeenCalledOnce();
		invalidateUmbodAnalytics();
	});

	it("adapts every Vault response shape without weakening validation", async () => {
		const { buildVaultSnapshotOffMainThread } = await import(
			"./vaultSnapshotWorkerClient"
		);
		const config = {} as HlidConfig;
		const missingFingerprint = buildVaultSnapshotOffMainThread(
			config,
			"config-1",
		);
		const worker = FakeWorker.instances[0];
		const firstRequest = postedRequest(worker);
		expect(firstRequest).toMatchObject({
			config,
			configKey: "config-1",
		});
		worker.emit("message", { data: { id: firstRequest.id } });
		await expect(missingFingerprint).rejects.toThrow(
			"Vault snapshot worker returned no fingerprint",
		);

		const unchanged = buildVaultSnapshotOffMainThread(
			config,
			"config-1",
			"prior",
		);
		const secondRequest = postedRequest(worker, 1);
		worker.emit("message", {
			data: {
				id: secondRequest.id,
				contentKey: "current",
				unchanged: true,
			},
		});
		await expect(unchanged).resolves.toEqual({
			changed: false,
			contentKey: "current",
		});

		const changed = buildVaultSnapshotOffMainThread(config, "config-1");
		const thirdRequest = postedRequest(worker, 2);
		const data = { files: [{ path: "Notes/One.md" }] };
		worker.emit("message", {
			data: { id: thirdRequest.id, contentKey: "next", data },
		});
		await expect(changed).resolves.toEqual({
			changed: true,
			contentKey: "next",
			data,
		});
	});

	it("preserves Vault protocol errors and unexpected-close handling", async () => {
		const { buildVaultSnapshotOffMainThread } = await import(
			"./vaultSnapshotWorkerClient"
		);
		const failed = buildVaultSnapshotOffMainThread(
			{} as HlidConfig,
			"config-1",
		);
		const worker = FakeWorker.instances[0];
		const firstRequest = postedRequest(worker);
		worker.emit("message", {
			data: { id: firstRequest.id, error: "Vault scan failed" },
		});
		await expect(failed).rejects.toThrow("Vault scan failed");

		const closed = buildVaultSnapshotOffMainThread(
			{} as HlidConfig,
			"config-1",
		);
		worker.emit("close", {});
		await expect(closed).rejects.toThrow(
			"Vault snapshot worker closed unexpectedly",
		);
		expect(worker.terminate).not.toHaveBeenCalled();
	});
});
