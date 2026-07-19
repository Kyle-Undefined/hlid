import { describe, expect, it, vi } from "vitest";
import { observeCliProxyInstallJob } from "./cliproxyInstallJob";
import type { CliProxyStatus } from "./cliproxyManager";

const downloading: CliProxyStatus = {
	state: "downloading",
	managed: true,
	authenticated: false,
	oauth: "idle",
	accounts: {
		codex: "idle",
		claude: "idle",
		antigravity: "idle",
		kimi: "idle",
		xai: "idle",
	},
	download: { received: 0, total: null },
};

describe("CLIProxy background install", () => {
	it("returns the polling snapshot without waiting for installation", async () => {
		let finish: (() => void) | undefined;
		const operation = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const onInstalled = vi.fn(async () => {});
		const onError = vi.fn();

		const status = observeCliProxyInstallJob(
			{ status: downloading, completion: operation },
			onInstalled,
			onError,
		);

		expect(status).toBe(downloading);
		expect(onInstalled).not.toHaveBeenCalled();
		finish?.();
		await operation;
		await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
		expect(onError).not.toHaveBeenCalled();
	});

	it("observes background failures", async () => {
		const failure = new Error("download failed");
		const onError = vi.fn();
		observeCliProxyInstallJob(
			{
				status: downloading,
				completion: Promise.reject(failure),
			},
			async () => {},
			onError,
		);

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
	});
});
