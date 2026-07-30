import type { HlidConfig } from "../config";
import {
	discoverExtensionInventory,
	type ExtensionInventory,
	type ExtensionReview,
	reviewAvailableExtension,
} from "./extensionInventory";
import {
	ExtensionMutationError,
	type ExtensionMutationInput,
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

function validExtensionId(value: unknown): boolean {
	return typeof value === "string" && /^[0-9a-f]{24}$/.test(value);
}

function validExpectedSource(value: unknown): boolean {
	return typeof value === "string" && value.length <= 2_048;
}

function isValidExtensionMutation(
	input: Record<string, unknown>,
): input is ExtensionMutationInput {
	return (
		(input.action === "install" &&
			validExtensionId(input.id) &&
			typeof input.reviewToken === "string" &&
			/^[0-9a-f]{64}$/.test(input.reviewToken)) ||
		(input.action === "uninstall" &&
			validExtensionId(input.id) &&
			typeof input.expectedVersion === "string" &&
			input.expectedVersion.length <= 128) ||
		(input.action === "update" &&
			validExtensionId(input.id) &&
			typeof input.expectedVersion === "string" &&
			input.expectedVersion.length <= 128) ||
		(input.action === "set_enabled" &&
			validExtensionId(input.id) &&
			typeof input.expectedVersion === "string" &&
			input.expectedVersion.length <= 128 &&
			typeof input.expectedEnabled === "boolean" &&
			typeof input.enabled === "boolean" &&
			input.enabled !== input.expectedEnabled) ||
		(input.action === "add_marketplace" &&
			(input.providerId === "claude" || input.providerId === "codex") &&
			validExtensionId(input.environmentId) &&
			typeof input.source === "string" &&
			input.source.length <= 2_048 &&
			(input.ref === undefined ||
				(typeof input.ref === "string" && input.ref.length <= 256)) &&
			(input.sparse === undefined ||
				(Array.isArray(input.sparse) &&
					input.sparse.length <= 20 &&
					input.sparse.every(
						(value) => typeof value === "string" && value.length <= 512,
					)))) ||
		((input.action === "upgrade_marketplace" ||
			input.action === "remove_marketplace") &&
			validExtensionId(input.id) &&
			validExpectedSource(input.expectedSource))
	);
}

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
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				return Response.json(
					{ error: "Invalid extension mutation" },
					{ status: 400 },
				);
			}
			const input = body as Record<string, unknown>;
			if (!isValidExtensionMutation(input)) {
				return Response.json(
					{ error: "Invalid extension mutation" },
					{ status: 400 },
				);
			}
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
