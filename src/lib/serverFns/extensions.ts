/** Claude and Codex plugin inventory, review, and guarded native mutations. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson } from "#/lib/dbClient";
import type {
	ExtensionInventory,
	ExtensionReview,
} from "#/server/extensionInventory";
import type {
	ExtensionMutationInput,
	ExtensionMutationResult,
} from "#/server/extensionMutations";

const EMPTY_EXTENSION_INVENTORY: ExtensionInventory = {
	generatedAt: "",
	environments: [],
	extensions: [],
	marketplaces: [],
	available: [],
	errors: [],
};

export const getExtensionInventoryFn = createServerFn({
	method: "GET",
}).handler(() =>
	dbJson<ExtensionInventory>("/extensions/catalog", EMPTY_EXTENSION_INVENTORY),
);

export const getExtensionReviewFn = createServerFn({ method: "GET" })
	.validator((raw) =>
		z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }).parse(raw),
	)
	.handler(({ data }) =>
		dbJson<ExtensionReview | null>(
			`/extensions/review?id=${encodeURIComponent(data.id)}`,
			null,
		),
	);

const extensionMutationSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("install"),
		id: z.string().regex(/^[0-9a-f]{24}$/),
		reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
	}),
	z.object({
		action: z.literal("uninstall"),
		id: z.string().regex(/^[0-9a-f]{24}$/),
		expectedVersion: z.string().max(128),
	}),
	z.object({
		action: z.literal("set_enabled"),
		id: z.string().regex(/^[0-9a-f]{24}$/),
		expectedVersion: z.string().max(128),
		expectedEnabled: z.boolean(),
		enabled: z.boolean(),
	}),
	z.object({
		action: z.literal("add_marketplace"),
		providerId: z.enum(["claude", "codex"]),
		environmentId: z.string().regex(/^[0-9a-f]{24}$/),
		source: z.string().min(1).max(2_048),
		ref: z.string().max(256).optional(),
		sparse: z.array(z.string().min(1).max(512)).max(20).optional(),
	}),
	z.object({
		action: z.literal("upgrade_marketplace"),
		id: z.string().regex(/^[0-9a-f]{24}$/),
		expectedSource: z.string().max(2_048),
	}),
	z.object({
		action: z.literal("remove_marketplace"),
		id: z.string().regex(/^[0-9a-f]{24}$/),
		expectedSource: z.string().max(2_048),
	}),
]);

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
