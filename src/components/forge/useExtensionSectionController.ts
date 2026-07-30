import { useCallback, useEffect, useRef, useState } from "react";
import {
	getExtensionInventoryFn,
	getExtensionReviewFn,
	mutateExtensionFn,
	refreshExtensionInventoryFn,
} from "#/lib/serverFns/extensions";
import type {
	AvailableExtension,
	ExtensionInventory,
	ExtensionReview,
} from "#/server/extensionInventory";
import type {
	ExtensionMutationInput,
	ExtensionMutationResult,
} from "#/server/extensionMutations";

const EMPTY_INVENTORY: ExtensionInventory = {
	generatedAt: "",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

export type ExtensionMutationController = (
	input: ExtensionMutationInput,
	onSuccess?: () => void,
) => Promise<void>;

function mutationNotice(
	input: ExtensionMutationInput,
	result: ExtensionMutationResult,
): string {
	const subject = result.subject || result.pluginId || "Extension";
	let message: string;
	switch (result.action) {
		case "install":
			message = `${subject} installed in ${result.environmentLabel}.`;
			break;
		case "update":
		case "upgrade_marketplace":
			message = `${subject} updated in ${result.environmentLabel}.`;
			break;
		case "uninstall":
		case "remove_marketplace":
			message = `${subject} removed from ${result.environmentLabel}.`;
			break;
		case "set_enabled":
			message =
				input.action === "set_enabled"
					? `${subject} ${input.enabled ? "enabled" : "disabled"} in ${result.environmentLabel}.`
					: `${subject} updated in ${result.environmentLabel}.`;
			break;
		case "add_marketplace":
			message = `${subject} added in ${result.environmentLabel}.`;
			break;
	}
	return `${message}${result.warning ? ` ${result.warning}` : ""}`;
}

function useExtensionInventory(isMounted: () => boolean) {
	const [inventory, setInventory] =
		useState<ExtensionInventory>(EMPTY_INVENTORY);
	const [inventoryGeneration, setInventoryGeneration] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const requestIdRef = useRef(0);
	const loadInventory = useCallback(
		async (request: () => Promise<ExtensionInventory>) => {
			if (!isMounted()) return;
			const requestId = ++requestIdRef.current;
			setLoading(true);
			setError(null);
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
				}
			}
		},
		[isMounted],
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
		};
	}, [load]);
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
	const clearReview = useCallback(() => {
		requestIdRef.current += 1;
		if (!isMounted()) return;
		setReview(null);
		setReviewingId(null);
		setReviewError(null);
	}, [isMounted]);
	useEffect(
		() => () => {
			requestIdRef.current += 1;
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
			setReviewingId(extension.id);
			setReviewError(null);
			setReview(null);
			try {
				const nextReview = await getExtensionReviewFn({
					data: { id: extension.id },
				});
				if (isMounted() && requestId === requestIdRef.current) {
					setReview(nextReview);
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
	return { review, reviewingId, reviewError, clearReview, reviewExtension };
}

function useExtensionMutation(
	load: () => Promise<void>,
	clearReview: () => void,
	isMounted: () => boolean,
) {
	const [mutatingId, setMutatingId] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 5_000);
		return () => clearTimeout(timer);
	}, [notice]);
	const mutate = useCallback<ExtensionMutationController>(
		async (input, onSuccess) => {
			if (!isMounted()) return;
			setMutatingId("environmentId" in input ? input.environmentId : input.id);
			setNotice(null);
			setError(null);
			try {
				const { result } = await mutateExtensionFn({ data: input });
				if (!isMounted()) return;
				setNotice(mutationNotice(input, result));
				onSuccess?.();
				clearReview();
				await load();
			} catch (cause) {
				if (!isMounted()) return;
				setError(
					cause instanceof Error ? cause.message : "Extension action failed",
				);
				// Native CLIs can change provider state before returning a failure.
				// Always replace the visible catalog with a fresh provider snapshot.
				await load().catch(() => {});
			} finally {
				if (isMounted()) {
					setMutatingId(null);
				}
			}
		},
		[clearReview, isMounted, load],
	);
	return {
		mutatingId,
		mutationNotice: notice,
		mutationError: error,
		mutate,
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
	const mutation = useExtensionMutation(
		inventory.load,
		review.clearReview,
		isMounted,
	);
	return {
		...inventory,
		...review,
		...mutation,
	};
}

export type ExtensionSectionController = ReturnType<
	typeof useExtensionSectionController
>;
