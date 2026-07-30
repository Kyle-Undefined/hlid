import type { HlidConfig } from "../config";
import {
	type ExtensionMutationInput,
	extensionMutationSchema,
} from "../lib/extensionMutation";
import {
	discoverExtensionInventory,
	type ExtensionInventory,
	type ExtensionReview,
	reviewAvailableExtension,
} from "./extensionInventory";
import {
	ExtensionMutationError,
	type ExtensionMutationResult,
	mutateProviderExtension,
} from "./extensionMutations";

type ExtensionRouteDependencies = {
	loadConfig: () => HlidConfig;
	discover?: (config: HlidConfig) => Promise<ExtensionInventory>;
	review?: (config: HlidConfig, id: string) => Promise<ExtensionReview | null>;
	mutate?: (
		config: HlidConfig,
		input: ExtensionMutationInput,
	) => Promise<ExtensionMutationResult>;
	onChanged?: (config: HlidConfig) => void | Promise<void>;
};

const EXTENSION_CATALOG_CACHE_MS = 5_000;

export function createExtensionRouteHandler(
	dependencies: ExtensionRouteDependencies,
) {
	let catalogCache:
		| { inventory: ExtensionInventory; expiresAt: number; generation: number }
		| undefined;
	let catalogInflight:
		| { promise: Promise<ExtensionInventory>; generation: number }
		| undefined;
	let catalogGeneration = 0;

	const invalidateCatalog = () => {
		catalogGeneration += 1;
		catalogCache = undefined;
	};
	const readCatalog = async (): Promise<ExtensionInventory> => {
		const now = Date.now();
		if (
			catalogCache &&
			catalogCache.generation === catalogGeneration &&
			catalogCache.expiresAt > now
		) {
			return catalogCache.inventory;
		}
		if (catalogInflight?.generation === catalogGeneration) {
			return catalogInflight.promise;
		}
		const generation = catalogGeneration;
		const discover = dependencies.discover ?? discoverExtensionInventory;
		const promise = discover(dependencies.loadConfig());
		catalogInflight = { promise, generation };
		try {
			const inventory = await promise;
			if (generation === catalogGeneration) {
				catalogCache = {
					inventory,
					expiresAt: Date.now() + EXTENSION_CATALOG_CACHE_MS,
					generation,
				};
			}
			return inventory;
		} finally {
			if (catalogInflight?.promise === promise) catalogInflight = undefined;
		}
	};

	return async (url: URL, request: Request): Promise<Response | null> => {
		if (request.method === "POST" && url.pathname === "/extensions/mutate") {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}
			const parsed = extensionMutationSchema.safeParse(body);
			if (!parsed.success) {
				return Response.json(
					{ error: "Invalid extension mutation" },
					{ status: 400 },
				);
			}
			const input = parsed.data;
			try {
				const config = dependencies.loadConfig();
				const mutate = dependencies.mutate ?? mutateProviderExtension;
				const result = await mutate(config, input);
				invalidateCatalog();
				await dependencies.onChanged?.(config);
				return Response.json({ ok: true, result });
			} catch (error) {
				const mutationError =
					error instanceof ExtensionMutationError ? error : null;
				const stateChanged = mutationError?.stateChanged === true;
				if (mutationError?.refreshRequired) {
					invalidateCatalog();
					try {
						await dependencies.onChanged?.(dependencies.loadConfig());
					} catch {
						// Preserve the original mutation failure for the user.
					}
				}
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Extension mutation failed",
						...(stateChanged ? { stateChanged: true } : {}),
					},
					{ status: 400 },
				);
			}
		}
		if (request.method !== "GET") {
			return null;
		}
		if (url.pathname === "/extensions/catalog") {
			if (url.searchParams.get("refresh") === "1") {
				invalidateCatalog();
			}
			return Response.json(await readCatalog());
		}
		if (url.pathname === "/extensions/review") {
			const id = url.searchParams.get("id") ?? "";
			if (!/^[0-9a-f]{24}$/.test(id)) {
				return Response.json(
					{ error: "A valid extension review ID is required" },
					{ status: 400 },
				);
			}
			const review = dependencies.review ?? reviewAvailableExtension;
			const result = await review(dependencies.loadConfig(), id);
			return result
				? Response.json(result)
				: Response.json(
						{ error: "Extension review not found" },
						{ status: 404 },
					);
		}
		return null;
	};
}
