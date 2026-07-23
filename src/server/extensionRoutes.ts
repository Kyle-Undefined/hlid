import type { HlidConfig } from "../config";
import {
	discoverExtensionInventory,
	type ExtensionInventory,
	type ExtensionReview,
	reviewAvailableExtension,
} from "./extensionInventory";
import {
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

export function createExtensionRouteHandler(
	dependencies: ExtensionRouteDependencies,
) {
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
			const validId = (value: unknown) =>
				typeof value === "string" && /^[0-9a-f]{24}$/.test(value);
			const validExpectedSource = (value: unknown) =>
				typeof value === "string" && value.length <= 2_048;
			const validMutation =
				(input.action === "install" &&
					validId(input.id) &&
					typeof input.reviewToken === "string" &&
					/^[0-9a-f]{64}$/.test(input.reviewToken)) ||
				(input.action === "uninstall" &&
					validId(input.id) &&
					typeof input.expectedVersion === "string" &&
					input.expectedVersion.length <= 128) ||
				(input.action === "set_enabled" &&
					validId(input.id) &&
					typeof input.expectedVersion === "string" &&
					input.expectedVersion.length <= 128 &&
					typeof input.expectedEnabled === "boolean" &&
					typeof input.enabled === "boolean" &&
					input.enabled !== input.expectedEnabled) ||
				(input.action === "add_marketplace" &&
					(input.providerId === "claude" || input.providerId === "codex") &&
					validId(input.environmentId) &&
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
					validId(input.id) &&
					validExpectedSource(input.expectedSource));
			if (!validMutation) {
				return Response.json(
					{ error: "Invalid extension mutation" },
					{ status: 400 },
				);
			}
			try {
				const config = dependencies.loadConfig();
				const mutate = dependencies.mutate ?? mutateProviderExtension;
				const result = await mutate(config, input as ExtensionMutationInput);
				await dependencies.onChanged?.(config);
				return Response.json({ ok: true, result });
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Extension mutation failed",
					},
					{ status: 400 },
				);
			}
		}
		if (request.method !== "GET") {
			return null;
		}
		if (url.pathname === "/extensions/catalog") {
			const discover = dependencies.discover ?? discoverExtensionInventory;
			return Response.json(await discover(dependencies.loadConfig()));
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
