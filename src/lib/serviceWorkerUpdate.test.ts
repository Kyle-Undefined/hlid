import { describe, expect, it, vi } from "vitest";
import {
	serviceWorkerBuild,
	shouldReloadForServiceWorkerBuild,
} from "./serviceWorkerUpdate";

describe("service worker updates", () => {
	it("does not reload a page that already matches the newly active worker", () => {
		expect(shouldReloadForServiceWorkerBuild("build-2", "build-2")).toBe(false);
		expect(shouldReloadForServiceWorkerBuild("build-1", "build-2")).toBe(true);
		expect(shouldReloadForServiceWorkerBuild("build-2", null)).toBe(true);
	});

	it("reads the active worker build over a message channel", async () => {
		const worker = {
			postMessage: vi.fn((_message: unknown, transfer: Transferable[]) => {
				const port = transfer[0] as MessagePort;
				port.postMessage({ type: "hlid:build", build: "build-2" });
			}),
		};

		await expect(serviceWorkerBuild(worker, 100)).resolves.toBe("build-2");
	});
});
