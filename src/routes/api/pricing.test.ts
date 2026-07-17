import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGetPricing, handlePostPricing } from "./pricing";

vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));
vi.mock("#/lib/pricingCatalog", () => ({
	getPricingCatalogState: vi.fn(),
	parsePricingOverrides: vi.fn(),
	savePricingOverrides: vi.fn(),
}));

const { forbiddenResponse } = await import("#/lib/originGate");
const { getPricingCatalogState, parsePricingOverrides, savePricingOverrides } =
	await import("#/lib/pricingCatalog");

const mockForbiddenResponse = vi.mocked(forbiddenResponse);
const state = {
	path: "/data/pricing-overrides.toml",
	exists: false,
	text: "version = 1\n",
	error: null,
	models: [],
	aliases: [],
};

function get(): Request {
	return new Request("http://localhost/api/pricing");
}

function post(body: unknown): Request {
	return new Request("http://localhost/api/pricing", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("/api/pricing", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockForbiddenResponse.mockReturnValue(null);
		vi.mocked(getPricingCatalogState).mockReturnValue(state);
		vi.mocked(savePricingOverrides).mockReturnValue({ ...state, exists: true });
	});

	it("returns the merged catalog without caching it", async () => {
		const response = await handleGetPricing(get());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual(state);
	});

	it("validates and saves an override file", async () => {
		const response = await handlePostPricing(post({ text: "version = 1\n" }));
		expect(response.status).toBe(200);
		expect(parsePricingOverrides).toHaveBeenCalledWith("version = 1\n");
		expect(savePricingOverrides).toHaveBeenCalledWith("version = 1\n");
		expect(await response.json()).toMatchObject({ exists: true });
	});

	it("rejects malformed bodies, invalid TOML, and oversized files", async () => {
		expect((await handlePostPricing(post({ nope: true }))).status).toBe(400);

		vi.mocked(parsePricingOverrides).mockImplementationOnce(() => {
			throw new Error("bad window");
		});
		const invalid = await handlePostPricing(post({ text: "bad" }));
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "bad window" });

		const oversized = await handlePostPricing(
			post({ text: "x".repeat(256 * 1024 + 1) }),
		);
		expect(oversized.status).toBe(413);
		expect(savePricingOverrides).not.toHaveBeenCalled();
	});

	it("returns guarded and persistence errors without writing through", async () => {
		mockForbiddenResponse.mockReturnValueOnce(
			new Response("Forbidden", { status: 403 }),
		);
		expect((await handlePostPricing(post({ text: "" }))).status).toBe(403);

		vi.mocked(savePricingOverrides).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const failed = await handlePostPricing(post({ text: "version = 1" }));
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({
			error: "Failed to write pricing overrides",
		});
	});
});
