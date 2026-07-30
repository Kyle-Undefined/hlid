import { useCallback, useEffect, useRef, useState } from "react";
import {
	getExtensionInventoryFn,
	getExtensionReviewFn,
	refreshExtensionInventoryFn,
} from "#/lib/serverFns/extensions";
import type {
	AvailableExtension,
	ExtensionInventory,
	ExtensionReview,
} from "#/server/extensionInventory";
import { useExtensionMutationController } from "./useExtensionMutationController";

export type {
	ExtensionMutationSurface,
	ExtensionTargetMutationState,
} from "./useExtensionMutationController";

const EMPTY_INVENTORY: ExtensionInventory = {
	generatedAt: "",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

function useExtensionInventory(isMounted: () => boolean) {
	const [inventory, setInventory] =
		useState<ExtensionInventory>(EMPTY_INVENTORY);
	const [inventoryGeneration, setInventoryGeneration] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const requestIdRef = useRef(0);
	const barrierWaitersRef = useRef(new Map<number, () => void>());
	const settleBarriersThrough = useCallback((requestId: number) => {
		for (const [waitingFor, resolve] of barrierWaitersRef.current) {
			if (waitingFor > requestId) continue;
			barrierWaitersRef.current.delete(waitingFor);
			resolve();
		}
	}, []);
	const settleAllBarriers = useCallback(() => {
		for (const resolve of barrierWaitersRef.current.values()) resolve();
		barrierWaitersRef.current.clear();
	}, []);
	const loadInventory = useCallback(
		(request: () => Promise<ExtensionInventory>) => {
			if (!isMounted()) return Promise.resolve();
			const requestId = ++requestIdRef.current;
			const barrier = new Promise<void>((resolve) => {
				barrierWaitersRef.current.set(requestId, resolve);
			});
			setLoading(true);
			setError(null);
			void (async () => {
				try {
					const nextInventory = await request();
					if (isMounted() && requestId === requestIdRef.current) {
						setInventory(nextInventory);
						setInventoryGeneration((generation) => generation + 1);
					}
				} catch (cause) {
					if (isMounted() && requestId === requestIdRef.current) {
						setError(
							cause instanceof Error
								? cause.message
								: "Unable to inspect provider extensions",
						);
					}
				} finally {
					if (isMounted() && requestId === requestIdRef.current) {
						setLoading(false);
						settleBarriersThrough(requestId);
					}
				}
			})();
			return barrier;
		},
		[isMounted, settleBarriersThrough],
	);
	const load = useCallback(
		() => loadInventory(getExtensionInventoryFn),
		[loadInventory],
	);
	const retryInspection = useCallback(
		() => loadInventory(refreshExtensionInventoryFn),
		[loadInventory],
	);
	useEffect(() => {
		void load();
		return () => {
			requestIdRef.current += 1;
			settleAllBarriers();
		};
	}, [load, settleAllBarriers]);
	return {
		inventory,
		inventoryGeneration,
		loading,
		inventoryError: error,
		load,
		retryInspection,
	};
}

function useExtensionReview(isMounted: () => boolean) {
	const [review, setReview] = useState<ExtensionReview | null>(null);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const [reviewError, setReviewError] = useState<{
		id: string;
		message: string;
	} | null>(null);
	const requestIdRef = useRef(0);
	const targetIdRef = useRef<string | null>(null);
	const clearReview = useCallback(() => {
		requestIdRef.current += 1;
		targetIdRef.current = null;
		if (!isMounted()) return;
		setReview(null);
		setReviewingId(null);
		setReviewError(null);
	}, [isMounted]);
	const clearReviewForTarget = useCallback(
		(targetId: string) => {
			if (targetIdRef.current !== targetId) return;
			clearReview();
		},
		[clearReview],
	);
	useEffect(
		() => () => {
			requestIdRef.current += 1;
			targetIdRef.current = null;
		},
		[],
	);
	const reviewExtension = useCallback(
		async (extension: AvailableExtension) => {
			if (!isMounted()) return;
			if (review?.id === extension.id) {
				clearReview();
				return;
			}
			const requestId = ++requestIdRef.current;
			targetIdRef.current = extension.id;
			setReviewingId(extension.id);
			setReviewError(null);
			setReview(null);
			try {
				const nextReview = await getExtensionReviewFn({
					data: { id: extension.id },
				});
				if (isMounted() && requestId === requestIdRef.current) {
					setReview(nextReview);
					targetIdRef.current = nextReview?.id ?? null;
				}
			} catch (cause) {
				if (isMounted() && requestId === requestIdRef.current) {
					setReviewError({
						id: extension.id,
						message:
							cause instanceof Error
								? cause.message
								: "Unable to review this extension",
					});
				}
			} finally {
				if (isMounted() && requestId === requestIdRef.current) {
					setReviewingId(null);
				}
			}
		},
		[clearReview, isMounted, review?.id],
	);
	return {
		review,
		reviewingId,
		reviewError,
		clearReview,
		clearReviewForTarget,
		reviewExtension,
	};
}

export function useExtensionSectionController() {
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const isMounted = useCallback(() => mountedRef.current, []);
	const inventory = useExtensionInventory(isMounted);
	const review = useExtensionReview(isMounted);
	const mutation = useExtensionMutationController({
		load: inventory.load,
		clearReviewForTarget: review.clearReviewForTarget,
		isMounted,
	});
	return {
		...inventory,
		...review,
		mutation,
	};
}

export type ExtensionSectionController = ReturnType<
	typeof useExtensionSectionController
>;
