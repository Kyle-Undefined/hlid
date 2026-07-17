// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PricingCatalogState } from "#/lib/pricingCatalog";
import { PricingSection } from "./PricingSection";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const catalog: PricingCatalogState = {
	path: "/data/pricing-overrides.toml",
	exists: true,
	text: "version = 1\n",
	error: null,
	models: [
		{
			provider: "codex",
			model: "gpt-5.4",
			rates: {
				input: 2.5,
				cachedInput: 0.25,
				cacheWrite: 2.5,
				output: 15,
			},
			source: "built-in",
		},
		{
			provider: "codex",
			model: "gpt-next",
			effectiveFrom: "2026-09-01",
			rates: {
				input: 1,
				cachedInput: 0.1,
				cacheWrite: 1,
				output: 5,
			},
			source: "local",
		},
	],
	aliases: [
		{
			provider: "codex",
			alias: "codex-auto-review",
			model: "gpt-5.3-codex",
			source: "built-in",
		},
	],
};

function jsonResponse(data: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: vi.fn().mockResolvedValue(data),
	} as unknown as Response;
}

describe("PricingSection", () => {
	it("shows the merged timelines and local file contract", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(catalog)));
		render(<PricingSection />);

		await screen.findByText("gpt-next");
		expect(screen.getByText("codex-auto-review")).toBeTruthy();
		expect(screen.getByText("/data/pricing-overrides.toml")).toBeTruthy();
		expect(
			screen.getByText(/Existing priced ledger rows stay frozen/),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Validate & save",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("validates and saves edited TOML explicitly", async () => {
		const saved = { ...catalog, text: "version = 1\n# changed\n" };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(catalog))
			.mockResolvedValueOnce(jsonResponse(saved));
		vi.stubGlobal("fetch", fetchMock);
		render(<PricingSection />);

		const editor = (await screen.findByLabelText(
			"Pricing overrides TOML",
		)) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: saved.text } });
		fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));

		await screen.findByText("Pricing overrides saved");
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/pricing",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ text: saved.text }),
			}),
		);
		expect(editor.value).toBe(saved.text);
	});

	it("surfaces validation errors without discarding edits", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(catalog))
			.mockResolvedValueOnce(
				jsonResponse({ error: "Local model rules overlap" }, false, 400),
			);
		vi.stubGlobal("fetch", fetchMock);
		render(<PricingSection />);

		const editor = (await screen.findByLabelText(
			"Pricing overrides TOML",
		)) as HTMLTextAreaElement;
		fireEvent.change(editor, { target: { value: "bad edits" } });
		fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));

		await screen.findByText("Local model rules overlap");
		expect(editor.value).toBe("bad edits");
		expect(
			screen.getByRole("button", { name: "Discard & reload" }),
		).toBeTruthy();
		await waitFor(() =>
			expect(
				(
					screen.getByRole("button", {
						name: "Validate & save",
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);
	});
});
