import { describe, expect, it } from "vitest";
import {
	defaultEffortFor,
	effortOptionsFor,
	modelOptions,
} from "./providerOptions";
import type { ProviderInfo } from "./serverFns";

const provider: ProviderInfo = {
	id: "claude",
	label: "Claude",
	available: true,
	models: [
		{ value: "sonnet", label: "Sonnet", isDefault: true },
		{ value: "hidden-model", label: "Hidden", hidden: true },
		{
			value: "opus",
			label: "Opus",
			description: "the big one",
			efforts: [
				{ value: "low", label: "Low" },
				{ value: "high", label: "High", isDefault: true },
			],
		},
	],
	effortLevels: [
		{ value: "medium", label: "Medium" },
		{ value: "high", label: "High" },
	],
};

describe("modelOptions", () => {
	it("filters out hidden models", () => {
		const result = modelOptions(provider);
		expect(result.map((m) => m.value)).toEqual(["sonnet", "opus"]);
	});

	it("returns [] for undefined provider", () => {
		expect(modelOptions(undefined)).toEqual([]);
	});

	it("returns [] when provider has no models", () => {
		expect(modelOptions({ id: "x", label: "X", available: true })).toEqual([]);
	});
});

describe("effortOptionsFor", () => {
	it("uses the selected model's own efforts when present", () => {
		const result = effortOptionsFor(provider, "opus");
		expect(result).toEqual([
			{ value: "low", label: "Low" },
			{ value: "high", label: "High", isDefault: true },
		]);
	});

	it("falls back to provider-level effortLevels when the model has none", () => {
		const result = effortOptionsFor(provider, "sonnet");
		expect(result).toEqual(provider.effortLevels);
	});

	it("falls back to provider-level effortLevels when the model isn't found", () => {
		const result = effortOptionsFor(provider, "");
		expect(result).toEqual(provider.effortLevels);
	});

	it("returns [] when neither the model nor the provider declare efforts", () => {
		const bare: ProviderInfo = { id: "x", label: "X", available: true };
		expect(effortOptionsFor(bare, "anything")).toEqual([]);
	});

	it("returns [] for undefined provider", () => {
		expect(effortOptionsFor(undefined, "anything")).toEqual([]);
	});
});

describe("defaultEffortFor", () => {
	it("returns the selected model's default effort value", () => {
		expect(defaultEffortFor(provider, "opus")).toBe("high");
	});

	it("returns undefined when the selected model has no default effort", () => {
		expect(defaultEffortFor(provider, "sonnet")).toBeUndefined();
	});

	it("returns undefined when the model isn't found", () => {
		expect(defaultEffortFor(provider, "nope")).toBeUndefined();
	});

	it("returns undefined for undefined provider", () => {
		expect(defaultEffortFor(undefined, "anything")).toBeUndefined();
	});
});
