import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import {
	getPricingCatalogState,
	parsePricingOverrides,
	savePricingOverrides,
} from "#/lib/pricingCatalog";

const MAX_PRICING_OVERRIDES_BYTES = 256 * 1024;

function noStoreJson(body: unknown, init?: ResponseInit): Response {
	const response = Response.json(body, init);
	response.headers.set("cache-control", "no-store");
	return response;
}

export async function handleGetPricing(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		return noStoreJson(getPricingCatalogState());
	} catch {
		return noStoreJson(
			{ error: "Failed to read pricing overrides" },
			{ status: 500 },
		);
	}
}

export async function handlePostPricing(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	let text: string;
	try {
		const body = (await request.json()) as { text?: unknown };
		if (typeof body.text !== "string") throw new Error("Expected text");
		text = body.text;
	} catch {
		return noStoreJson(
			{ error: "Body must be JSON with a string text field" },
			{ status: 400 },
		);
	}
	if (new TextEncoder().encode(text).byteLength > MAX_PRICING_OVERRIDES_BYTES) {
		return noStoreJson(
			{ error: "Pricing overrides must be 256 KiB or smaller" },
			{ status: 413 },
		);
	}
	try {
		parsePricingOverrides(text);
	} catch (error) {
		return noStoreJson(
			{
				error:
					error instanceof Error ? error.message : "Invalid pricing overrides",
			},
			{ status: 400 },
		);
	}
	try {
		return noStoreJson(savePricingOverrides(text));
	} catch {
		return noStoreJson(
			{ error: "Failed to write pricing overrides" },
			{ status: 500 },
		);
	}
}

export const Route = createFileRoute("/api/pricing")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetPricing(request),
			POST: ({ request }) => handlePostPricing(request),
		},
	},
});
