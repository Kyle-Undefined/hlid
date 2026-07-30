/** Claude and Codex plugin inventory, review, and guarded native mutations. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson } from "#/lib/dbClient";
import {
	type ExtensionMutationInput,
	extensionMutationSchema,
} from "#/lib/extensionMutation";
import type {
	ExtensionInventory,
	ExtensionReview,
} from "#/server/extensionInventory";
import type { ExtensionMutationResult } from "#/server/extensionMutations";

const EMPTY_EXTENSION_INVENTORY: ExtensionInventory = {
	generatedAt: "",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

const EXTENSION_READ_BUDGET = {
	initialTimeoutMs: 15_000,
	retryTimeoutMs: false,
} as const;

export const getExtensionInventoryFn = createServerFn({
	method: "GET",
}).handler(() =>
	dbJson<ExtensionInventory>(
		"/extensions/catalog",
		EMPTY_EXTENSION_INVENTORY,
		EXTENSION_READ_BUDGET,
	),
);

export const refreshExtensionInventoryFn = createServerFn({
	method: "GET",
}).handler(() =>
	dbJson<ExtensionInventory>(
		"/extensions/catalog?refresh=1",
		EMPTY_EXTENSION_INVENTORY,
		EXTENSION_READ_BUDGET,
	),
);

export const getExtensionReviewFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }).parse(raw),
	)
	.handler(({ data }) =>
		dbJson<ExtensionReview | null>(
			`/extensions/review?id=${encodeURIComponent(data.id)}`,
			null,
			EXTENSION_READ_BUDGET,
		),
	);

export const mutateExtensionFn = createServerFn({ method: "POST" })
	.validator((raw) => extensionMutationSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await dbFetch("/extensions/mutate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(data satisfies ExtensionMutationInput),
		});
		const payload = (await response.json()) as {
			ok?: boolean;
			error?: string;
			result?: ExtensionMutationResult;
		};
		if (!response.ok || !payload.result) {
			throw new Error(
				payload.error ??
					(data.action === "install"
						? "Extension installation failed"
						: data.action === "update"
							? "Extension update failed"
							: data.action === "uninstall"
								? "Extension removal failed"
								: data.action === "set_enabled"
									? "Extension status change failed"
									: "Marketplace action failed"),
			);
		}
		return {
			ok: true,
			result: payload.result,
		} satisfies {
			ok: true;
			result: ExtensionMutationResult;
		};
	});
