import { describe, expect, it, vi } from "vitest";
import {
	consumeServiceWorkerNotificationNavigation,
	handleServiceWorkerNotificationNavigation,
	markServiceWorkerNotificationNavigation,
	serviceWorkerBuild,
	serviceWorkerNotificationRouteTarget,
	serviceWorkerNotificationTarget,
	shouldReloadForServiceWorkerBuild,
} from "./serviceWorkerUpdate";

describe("service worker updates", () => {
	it("marks notification-origin navigation without storing its target", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: vi.fn((key: string) => values.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => values.set(key, value)),
			removeItem: vi.fn((key: string) => values.delete(key)),
		};

		markServiceWorkerNotificationNavigation(storage, 10_000);
		expect([...values.values()]).toEqual(["10000"]);
		expect(consumeServiceWorkerNotificationNavigation(storage, 20_000)).toBe(
			true,
		);
		expect(consumeServiceWorkerNotificationNavigation(storage, 20_001)).toBe(
			false,
		);

		markServiceWorkerNotificationNavigation(storage, 30_000);
		expect(consumeServiceWorkerNotificationNavigation(storage, 61_000)).toBe(
			false,
		);
		expect(values.size).toBe(0);
	});

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

	it("accepts only a bounded same-origin notification navigation", () => {
		expect(
			serviceWorkerNotificationTarget(
				{
					type: "hlid:navigate-notification",
					url: "/raven?session=session-1",
				},
				"https://hlid.test",
			),
		).toBe("/raven?session=session-1");
		expect(
			serviceWorkerNotificationTarget(
				{
					type: "hlid:navigate-notification",
					url: "//attacker.test/raven",
				},
				"https://hlid.test",
			),
		).toBeNull();
		expect(
			serviceWorkerNotificationTarget(
				{
					type: "hlid:navigate-notification",
					url: "/raven\n?session=session-1",
				},
				"https://hlid.test",
			),
		).toBeNull();
		expect(
			serviceWorkerNotificationTarget(
				{ type: "other", url: "/raven" },
				"https://hlid.test",
			),
		).toBeNull();
	});

	it("marks only validated Raven route navigation as notification-originated", () => {
		expect(
			serviceWorkerNotificationRouteTarget(
				"/raven?session=session-1&attention=question",
				"https://hlid.test",
			),
		).toBe("/raven?session=session-1&attention=question&notification_open=1");
		expect(
			serviceWorkerNotificationRouteTarget(
				"/watch?routine=one&routine_run=two",
				"https://hlid.test",
			),
		).toBe("/watch?routine=one&routine_run=two");
		expect(
			serviceWorkerNotificationRouteTarget(
				"https://attacker.test/raven?session=session-1",
				"https://hlid.test",
			),
		).toBe("/");
	});

	it("hands a valid target to the live router and positively acknowledges it", () => {
		const navigate = vi.fn();
		const port = { postMessage: vi.fn(), close: vi.fn() };

		expect(
			handleServiceWorkerNotificationNavigation(
				{
					data: {
						type: "hlid:navigate-notification",
						version: 1,
						url: "/raven?session=session-1&attention=question",
					},
					ports: [port],
				},
				"https://hlid.test",
				navigate,
			),
		).toBe("/raven?session=session-1&attention=question");
		expect(navigate).toHaveBeenCalledWith(
			"/raven?session=session-1&attention=question",
		);
		expect(port.postMessage).toHaveBeenCalledWith({
			type: "hlid:navigate-notification-ack",
			accepted: true,
		});
		expect(port.close).toHaveBeenCalledOnce();
	});

	it("rejects malformed targets and navigation attempts that throw", () => {
		const malformedPort = { postMessage: vi.fn(), close: vi.fn() };
		const navigate = vi.fn();
		expect(
			handleServiceWorkerNotificationNavigation(
				{
					data: {
						type: "hlid:navigate-notification",
						url: "//attacker.test/raven",
					},
					ports: [malformedPort],
				},
				"https://hlid.test",
				navigate,
			),
		).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
		expect(malformedPort.postMessage).toHaveBeenCalledWith({
			type: "hlid:navigate-notification-ack",
			accepted: false,
		});

		const failedPort = { postMessage: vi.fn(), close: vi.fn() };
		expect(
			handleServiceWorkerNotificationNavigation(
				{
					data: {
						type: "hlid:navigate-notification",
						url: "/raven?session=session-1",
					},
					ports: [failedPort],
				},
				"https://hlid.test",
				() => {
					throw new Error("router unavailable");
				},
			),
		).toBeNull();
		expect(failedPort.postMessage).toHaveBeenCalledWith({
			type: "hlid:navigate-notification-ack",
			accepted: false,
		});
	});
});
