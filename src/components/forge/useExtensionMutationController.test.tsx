// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInventory } from "#/server/extensionInventory";
import type {
	ExtensionMutationInput,
	ExtensionMutationResult,
} from "#/server/extensionMutations";
import {
	type ExtensionMutationSurface,
	useExtensionMutationController,
} from "./useExtensionMutationController";
import {
	type ExtensionSectionController,
	useExtensionSectionController,
} from "./useExtensionSectionController";

const mocks = vi.hoisted(() => ({
	getExtensionInventory: vi.fn(),
	refreshExtensionInventory: vi.fn(),
	getExtensionReview: vi.fn(),
	mutateExtension: vi.fn(),
}));

vi.mock("#/lib/serverFns/extensions", () => ({
	getExtensionInventoryFn: () => mocks.getExtensionInventory(),
	refreshExtensionInventoryFn: () => mocks.refreshExtensionInventory(),
	getExtensionReviewFn: ({ data }: { data: { id: string } }) =>
		mocks.getExtensionReview(data),
	mutateExtensionFn: ({ data }: { data: ExtensionMutationInput }) =>
		mocks.mutateExtension(data),
}));

const EMPTY_INVENTORY: ExtensionInventory = {
	generatedAt: "2026-07-30T00:00:00.000Z",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (cause?: unknown) => void;
	const promise = new Promise<T>((fulfill, fail) => {
		resolve = fulfill;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function mutationResponse(
	action: ExtensionMutationInput["action"],
	subject = "extension@official",
	warning?: string,
) {
	return {
		ok: true as const,
		result: {
			action,
			providerId: "claude" as const,
			subject,
			pluginId: subject,
			environmentLabel: "WSL · Ubuntu",
			output: "ok",
			...(warning ? { warning } : {}),
		} satisfies ExtensionMutationResult,
	};
}

function MutationHarness({
	load,
	clearReview,
	capture,
}: {
	load: () => Promise<void>;
	clearReview: () => void;
	capture: (surface: ExtensionMutationSurface) => void;
}) {
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const isMounted = useCallback(() => mountedRef.current, []);
	const surface = useExtensionMutationController({
		load,
		clearReview,
		isMounted,
	});
	capture(surface);
	return <div data-testid="mutation-active">{String(surface.hasActive)}</div>;
}

function ControllerHarness({
	capture,
}: {
	capture: (controller: ExtensionSectionController) => void;
}) {
	const controller = useExtensionSectionController();
	capture(controller);
	return (
		<>
			<div data-testid="inventory-generated-at">
				{controller.inventory.generatedAt}
			</div>
			<div data-testid="inventory-error">{controller.inventoryError}</div>
		</>
	);
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("useExtensionMutationController", () => {
	it("claims the target synchronously and suppresses a second action on it", async () => {
		const pending = deferred<ReturnType<typeof mutationResponse>>();
		const firstCallback = vi.fn();
		const secondCallback = vi.fn();
		const load = vi.fn().mockResolvedValue(undefined);
		const clearReview = vi.fn();
		let surface!: ExtensionMutationSurface;
		mocks.mutateExtension.mockImplementation(() => pending.promise);
		render(
			<MutationHarness
				load={load}
				clearReview={clearReview}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);

		let first!: Promise<"succeeded" | "failed" | "busy" | "unmounted">;
		let secondStatus: "succeeded" | "failed" | "busy" | "unmounted" | undefined;
		await act(async () => {
			first = surface.mutate(
				{
					action: "update",
					id: "shared-target",
					expectedVersion: "1.0.0",
				},
				firstCallback,
			);
			secondStatus = await surface.mutate(
				{
					action: "uninstall",
					id: "shared-target",
					expectedVersion: "1.0.0",
				},
				secondCallback,
			);
		});

		expect(secondStatus).toBe("busy");
		expect(mocks.mutateExtension).toHaveBeenCalledOnce();
		expect(surface.stateFor("shared-target")).toEqual({
			blocked: true,
			activeAction: "update",
		});

		let firstStatus: Awaited<typeof first> | undefined;
		await act(async () => {
			pending.resolve(mutationResponse("update"));
			firstStatus = await first;
		});
		expect(firstStatus).toBe("succeeded");
		expect(firstCallback).toHaveBeenCalledOnce();
		expect(secondCallback).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledOnce();
		expect(clearReview).toHaveBeenCalledOnce();
		expect(surface.stateFor("shared-target")).toEqual({
			blocked: false,
			activeAction: null,
		});
	});

	it("uses environmentId only for add_marketplace and id for every other action", async () => {
		const inputs: ExtensionMutationInput[] = [
			{
				action: "install",
				id: "available-target",
				reviewToken: "a".repeat(64),
			},
			{
				action: "uninstall",
				id: "uninstall-target",
				expectedVersion: "1",
			},
			{ action: "update", id: "update-target", expectedVersion: "1" },
			{
				action: "set_enabled",
				id: "enabled-target",
				expectedVersion: "1",
				expectedEnabled: true,
				enabled: false,
			},
			{
				action: "add_marketplace",
				providerId: "claude",
				environmentId: "environment-target",
				source: "example/plugins",
			},
			{
				action: "upgrade_marketplace",
				id: "upgrade-target",
				expectedSource: "example/plugins",
			},
			{
				action: "remove_marketplace",
				id: "remove-target",
				expectedSource: "example/plugins",
			},
		];
		const pending = inputs.map(() =>
			deferred<ReturnType<typeof mutationResponse>>(),
		);
		const load = vi.fn().mockResolvedValue(undefined);
		let surface!: ExtensionMutationSurface;
		mocks.mutateExtension.mockImplementation(
			() => pending[mocks.mutateExtension.mock.calls.length - 1]?.promise,
		);
		render(
			<MutationHarness
				load={load}
				clearReview={vi.fn()}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);

		let operations: Promise<"succeeded" | "failed" | "busy" | "unmounted">[] =
			[];
		act(() => {
			operations = inputs.map((input) => surface.mutate(input));
		});
		const expectedTargets = [
			"available-target",
			"uninstall-target",
			"update-target",
			"enabled-target",
			"environment-target",
			"upgrade-target",
			"remove-target",
		];
		for (const [index, targetId] of expectedTargets.entries()) {
			expect(surface.stateFor(targetId)).toEqual({
				blocked: true,
				activeAction: inputs[index]?.action,
			});
		}

		await act(async () => {
			for (const [index, request] of pending.entries()) {
				const action = inputs[index]?.action;
				if (!action) throw new Error("Mutation input is missing");
				request.resolve(mutationResponse(action, `${action}@official`));
			}
			await Promise.all(operations);
		});
		expect(mocks.mutateExtension).toHaveBeenCalledTimes(inputs.length);
		expect(surface.hasActive).toBe(false);
	});

	it("owns active state, feedback, and expiry independently per target", async () => {
		vi.useFakeTimers();
		const first = deferred<ReturnType<typeof mutationResponse>>();
		const second = deferred<ReturnType<typeof mutationResponse>>();
		const retry = deferred<ReturnType<typeof mutationResponse>>();
		mocks.mutateExtension
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise)
			.mockImplementationOnce(() => retry.promise);
		const load = vi.fn().mockResolvedValue(undefined);
		let surface!: ExtensionMutationSurface;
		render(
			<MutationHarness
				load={load}
				clearReview={vi.fn()}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);

		let firstOperation!: ReturnType<ExtensionMutationSurface["mutate"]>;
		let secondOperation!: ReturnType<ExtensionMutationSurface["mutate"]>;
		act(() => {
			firstOperation = surface.mutate({
				action: "install",
				id: "first-target",
				reviewToken: "a".repeat(64),
			});
			secondOperation = surface.mutate({
				action: "add_marketplace",
				providerId: "codex",
				environmentId: "second-target",
				source: "example/plugins",
			});
		});
		expect(surface.hasActive).toBe(true);
		expect(surface.stateFor("first-target").blocked).toBe(true);
		expect(surface.stateFor("second-target").blocked).toBe(true);

		await act(async () => {
			first.resolve(
				mutationResponse(
					"install",
					"first@official",
					"Provider verification warning.",
				),
			);
			expect(await firstOperation).toBe("succeeded");
		});
		expect(surface.stateFor("first-target").blocked).toBe(false);
		expect(surface.stateFor("second-target").blocked).toBe(true);
		expect(surface.feedback).toEqual([
			expect.objectContaining({
				targetId: "first-target",
				kind: "success",
				message:
					"first@official installed in WSL · Ubuntu. Provider verification warning.",
			}),
		]);

		await act(async () => {
			second.reject(new Error("Marketplace action failed"));
			expect(await secondOperation).toBe("failed");
		});
		expect(surface.stateFor("second-target").blocked).toBe(false);
		expect(surface.feedback).toEqual([
			expect.objectContaining({
				targetId: "first-target",
				kind: "success",
			}),
			expect.objectContaining({
				targetId: "second-target",
				kind: "error",
				message: "Marketplace action failed",
			}),
		]);

		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		expect(surface.feedback).toEqual([
			expect.objectContaining({
				targetId: "second-target",
				kind: "error",
			}),
		]);
		const errorOperationId = surface.feedback[0]?.operationId;
		if (errorOperationId === undefined) {
			throw new Error("Expected owned error feedback");
		}
		act(() => {
			surface.dismissFeedback("second-target", errorOperationId + 1);
		});
		expect(surface.feedback).toHaveLength(1);
		act(() => {
			surface.dismissFeedback("second-target", errorOperationId);
		});
		expect(surface.feedback).toEqual([]);

		let retryOperation!: ReturnType<ExtensionMutationSurface["mutate"]>;
		act(() => {
			retryOperation = surface.mutate({
				action: "add_marketplace",
				providerId: "codex",
				environmentId: "second-target",
				source: "example/plugins",
			});
		});
		expect(surface.feedback).toEqual([]);
		await act(async () => {
			retry.resolve(mutationResponse("add_marketplace", "example/plugins"));
			expect(await retryOperation).toBe("succeeded");
		});
	});

	it("does not let an older success timer clear newer target feedback", async () => {
		vi.useFakeTimers();
		mocks.mutateExtension
			.mockResolvedValueOnce(mutationResponse("update", "first@official"))
			.mockResolvedValueOnce(mutationResponse("update", "second@official"));
		let surface!: ExtensionMutationSurface;
		render(
			<MutationHarness
				load={vi.fn().mockResolvedValue(undefined)}
				clearReview={vi.fn()}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);
		const input: ExtensionMutationInput = {
			action: "update",
			id: "shared-target",
			expectedVersion: "1",
		};

		await act(async () => {
			expect(await surface.mutate(input)).toBe("succeeded");
		});
		const firstOperationId = surface.feedback[0]?.operationId;
		act(() => {
			vi.advanceTimersByTime(4_000);
		});
		await act(async () => {
			expect(await surface.mutate(input)).toBe("succeeded");
		});
		expect(surface.feedback[0]).toEqual(
			expect.objectContaining({
				targetId: "shared-target",
				message: "second@official updated in WSL · Ubuntu.",
			}),
		);
		expect(surface.feedback[0]?.operationId).not.toBe(firstOperationId);

		act(() => {
			vi.advanceTimersByTime(1_000);
		});
		expect(surface.feedback).toHaveLength(1);
		act(() => {
			vi.advanceTimersByTime(4_000);
		});
		expect(surface.feedback).toEqual([]);
	});

	it("isolates callback exceptions and returns explicit failure status", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const load = vi.fn().mockResolvedValue(undefined);
		const clearReview = vi.fn();
		const callback = vi.fn(() => {
			throw new Error("Draft cleanup failed");
		});
		let surface!: ExtensionMutationSurface;
		mocks.mutateExtension
			.mockResolvedValueOnce(mutationResponse("add_marketplace", "team-tools"))
			.mockRejectedValueOnce(new Error("Provider command failed"));
		render(
			<MutationHarness
				load={load}
				clearReview={clearReview}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);

		let successStatus:
			| "succeeded"
			| "failed"
			| "busy"
			| "unmounted"
			| undefined;
		await act(async () => {
			successStatus = await surface.mutate(
				{
					action: "add_marketplace",
					providerId: "claude",
					environmentId: "success-target",
					source: "example/team-tools",
				},
				callback,
			);
		});
		expect(successStatus).toBe("succeeded");
		expect(callback).toHaveBeenCalledOnce();
		expect(clearReview).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledWith(
			"Extension mutation success callback failed",
			expect.any(Error),
		);
		expect(surface.feedback[0]?.kind).toBe("success");

		const failedCallback = vi.fn();
		let failureStatus:
			| "succeeded"
			| "failed"
			| "busy"
			| "unmounted"
			| undefined;
		await act(async () => {
			failureStatus = await surface.mutate(
				{
					action: "remove_marketplace",
					id: "failure-target",
					expectedSource: "example/plugins",
				},
				failedCallback,
			);
		});
		expect(failureStatus).toBe("failed");
		expect(failedCallback).not.toHaveBeenCalled();
		expect(clearReview).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledTimes(2);
		expect(surface.feedback).toEqual([
			expect.objectContaining({
				targetId: "success-target",
				kind: "success",
			}),
			expect.objectContaining({
				targetId: "failure-target",
				kind: "error",
				message: "Provider command failed",
			}),
		]);
	});

	it("returns unmounted without post-settlement callback or reconciliation", async () => {
		const pending = deferred<ReturnType<typeof mutationResponse>>();
		const load = vi.fn().mockResolvedValue(undefined);
		const clearReview = vi.fn();
		const callback = vi.fn();
		let surface!: ExtensionMutationSurface;
		mocks.mutateExtension.mockImplementation(() => pending.promise);
		const view = render(
			<MutationHarness
				load={load}
				clearReview={clearReview}
				capture={(next) => {
					surface = next;
				}}
			/>,
		);
		const operation = surface.mutate(
			{
				action: "update",
				id: "unmounted-target",
				expectedVersion: "1",
			},
			callback,
		);

		view.unmount();
		let status: "succeeded" | "failed" | "busy" | "unmounted" | undefined;
		await act(async () => {
			pending.resolve(mutationResponse("update"));
			status = await operation;
		});
		expect(status).toBe("unmounted");
		expect(callback).not.toHaveBeenCalled();
		expect(clearReview).not.toHaveBeenCalled();
		expect(load).not.toHaveBeenCalled();
		expect(
			await surface.mutate({
				action: "update",
				id: "after-unmount",
				expectedVersion: "1",
			}),
		).toBe("unmounted");
	});
});

describe("extension inventory request barriers", () => {
	it("keeps concurrent mutations active until the newest inventory scan settles", async () => {
		const firstMutation = deferred<ReturnType<typeof mutationResponse>>();
		const secondMutation = deferred<ReturnType<typeof mutationResponse>>();
		const staleInventory = deferred<ExtensionInventory>();
		const currentInventory = deferred<ExtensionInventory>();
		mocks.mutateExtension.mockImplementation((input: ExtensionMutationInput) =>
			input.action !== "add_marketplace" && input.id === "first-target"
				? firstMutation.promise
				: secondMutation.promise,
		);
		mocks.getExtensionInventory
			.mockResolvedValueOnce(EMPTY_INVENTORY)
			.mockImplementationOnce(() => staleInventory.promise)
			.mockImplementationOnce(() => currentInventory.promise);
		let controller!: ExtensionSectionController;
		render(
			<ControllerHarness
				capture={(next) => {
					controller = next;
				}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
				EMPTY_INVENTORY.generatedAt,
			),
		);

		let firstOperation!: ReturnType<ExtensionMutationSurface["mutate"]>;
		let secondOperation!: ReturnType<ExtensionMutationSurface["mutate"]>;
		act(() => {
			firstOperation = controller.mutation.mutate({
				action: "update",
				id: "first-target",
				expectedVersion: "1",
			});
			secondOperation = controller.mutation.mutate({
				action: "add_marketplace",
				providerId: "codex",
				environmentId: "second-target",
				source: "example/plugins",
			});
		});

		await act(async () => {
			firstMutation.resolve(mutationResponse("update", "first@official"));
			await firstMutation.promise;
		});
		await waitFor(() =>
			expect(mocks.getExtensionInventory).toHaveBeenCalledTimes(2),
		);
		await act(async () => {
			secondMutation.resolve(
				mutationResponse("add_marketplace", "example/plugins"),
			);
			await secondMutation.promise;
		});
		await waitFor(() =>
			expect(mocks.getExtensionInventory).toHaveBeenCalledTimes(3),
		);
		expect(controller.mutation.stateFor("first-target").blocked).toBe(true);
		expect(controller.mutation.stateFor("second-target").blocked).toBe(true);

		await act(async () => {
			staleInventory.resolve({
				...EMPTY_INVENTORY,
				generatedAt: "2026-07-30T00:01:00.000Z",
			});
			await staleInventory.promise;
		});
		expect(controller.mutation.stateFor("first-target").blocked).toBe(true);
		expect(controller.mutation.stateFor("second-target").blocked).toBe(true);
		expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
			EMPTY_INVENTORY.generatedAt,
		);

		const newestInventory = {
			...EMPTY_INVENTORY,
			generatedAt: "2026-07-30T00:02:00.000Z",
		};
		await act(async () => {
			currentInventory.resolve(newestInventory);
			expect(await firstOperation).toBe("succeeded");
			expect(await secondOperation).toBe("succeeded");
		});
		expect(controller.mutation.stateFor("first-target").blocked).toBe(false);
		expect(controller.mutation.stateFor("second-target").blocked).toBe(false);
		expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
			newestInventory.generatedAt,
		);
	});

	it("settles older barriers when the latest request finishes first", async () => {
		const older = deferred<ExtensionInventory>();
		const newer = deferred<ExtensionInventory>();
		mocks.getExtensionInventory
			.mockResolvedValueOnce(EMPTY_INVENTORY)
			.mockImplementationOnce(() => older.promise)
			.mockImplementationOnce(() => newer.promise);
		let controller!: ExtensionSectionController;
		render(
			<ControllerHarness
				capture={(next) => {
					controller = next;
				}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
				EMPTY_INVENTORY.generatedAt,
			),
		);

		let olderSettled = false;
		let newerSettled = false;
		let olderBarrier!: Promise<void>;
		let newerBarrier!: Promise<void>;
		act(() => {
			olderBarrier = controller.load().then(() => {
				olderSettled = true;
			});
			newerBarrier = controller.load().then(() => {
				newerSettled = true;
			});
		});

		const newestInventory = {
			...EMPTY_INVENTORY,
			generatedAt: "2026-07-30T00:02:00.000Z",
		};
		await act(async () => {
			newer.resolve(newestInventory);
			await Promise.all([newer.promise, olderBarrier, newerBarrier]);
		});
		expect(olderSettled).toBe(true);
		expect(newerSettled).toBe(true);
		expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
			newestInventory.generatedAt,
		);

		await act(async () => {
			older.resolve({
				...EMPTY_INVENTORY,
				generatedAt: "2026-07-30T00:01:00.000Z",
			});
			await older.promise;
		});
		expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
			newestInventory.generatedAt,
		);
	});

	it("settles older barriers when the current request fails", async () => {
		const older = deferred<ExtensionInventory>();
		const current = deferred<ExtensionInventory>();
		mocks.getExtensionInventory
			.mockResolvedValueOnce(EMPTY_INVENTORY)
			.mockImplementationOnce(() => older.promise)
			.mockImplementationOnce(() => current.promise);
		let controller!: ExtensionSectionController;
		const view = render(
			<ControllerHarness
				capture={(next) => {
					controller = next;
				}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
				EMPTY_INVENTORY.generatedAt,
			),
		);

		let olderBarrier!: Promise<void>;
		let currentBarrier!: Promise<void>;
		act(() => {
			olderBarrier = controller.load();
			currentBarrier = controller.load();
		});
		await act(async () => {
			current.reject(new Error("Current inventory failed"));
			await Promise.all([olderBarrier, currentBarrier]);
		});
		expect(screen.getByTestId("inventory-error").textContent).toBe(
			"Current inventory failed",
		);

		view.unmount();
		older.resolve(EMPTY_INVENTORY);
		await older.promise;
	});

	it("settles every outstanding barrier on unmount", async () => {
		const pending = deferred<ExtensionInventory>();
		mocks.getExtensionInventory
			.mockResolvedValueOnce(EMPTY_INVENTORY)
			.mockImplementationOnce(() => pending.promise);
		let controller!: ExtensionSectionController;
		const view = render(
			<ControllerHarness
				capture={(next) => {
					controller = next;
				}}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("inventory-generated-at").textContent).toBe(
				EMPTY_INVENTORY.generatedAt,
			),
		);

		let settled = false;
		const barrier = controller.load().then(() => {
			settled = true;
		});
		view.unmount();
		await barrier;
		expect(settled).toBe(true);

		pending.resolve(EMPTY_INVENTORY);
		await pending.promise;
	});
});
