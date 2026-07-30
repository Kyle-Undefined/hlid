import { useCallback, useEffect, useState } from "react";
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

function useExtensionInventory() {
	const [inventory, setInventory] =
		useState<ExtensionInventory>(EMPTY_INVENTORY);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const loadInventory = useCallback(
		async (request: () => Promise<ExtensionInventory>) => {
			setLoading(true);
			setError(null);
			try {
				setInventory(await request());
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Unable to inspect provider extensions",
				);
			} finally {
				setLoading(false);
			}
		},
		[],
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
	}, [load]);
	return {
		inventory,
		loading,
		inventoryError: error,
		load,
		retryInspection,
	};
}

function useExtensionReview() {
	const [review, setReview] = useState<ExtensionReview | null>(null);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const [reviewError, setReviewError] = useState<{
		id: string;
		message: string;
	} | null>(null);
	const clearReview = useCallback(() => {
		setReview(null);
		setReviewError(null);
	}, []);
	const reviewExtension = useCallback(
		async (extension: AvailableExtension) => {
			if (review?.id === extension.id) {
				clearReview();
				return;
			}
			setReviewingId(extension.id);
			setReviewError(null);
			setReview(null);
			try {
				setReview(await getExtensionReviewFn({ data: { id: extension.id } }));
			} catch (cause) {
				setReviewError({
					id: extension.id,
					message:
						cause instanceof Error
							? cause.message
							: "Unable to review this extension",
				});
			} finally {
				setReviewingId(null);
			}
		},
		[clearReview, review?.id],
	);
	return { review, reviewingId, reviewError, clearReview, reviewExtension };
}

function useExtensionMutation(
	load: () => Promise<void>,
	clearReview: () => void,
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
			setMutatingId("environmentId" in input ? input.environmentId : input.id);
			setNotice(null);
			setError(null);
			try {
				const { result } = await mutateExtensionFn({ data: input });
				setNotice(mutationNotice(input, result));
				onSuccess?.();
				clearReview();
				await load();
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Extension action failed",
				);
				// Native CLIs can change provider state before returning a failure.
				// Always replace the visible catalog with a fresh provider snapshot.
				await load().catch(() => {});
			} finally {
				setMutatingId(null);
			}
		},
		[clearReview, load],
	);
	return {
		mutatingId,
		mutationNotice: notice,
		mutationError: error,
		mutate,
	};
}

export function useExtensionSectionController() {
	const inventory = useExtensionInventory();
	const review = useExtensionReview();
	const mutation = useExtensionMutation(inventory.load, review.clearReview);
	return {
		...inventory,
		...review,
		...mutation,
	};
}

export type ExtensionSectionController = ReturnType<
	typeof useExtensionSectionController
>;
