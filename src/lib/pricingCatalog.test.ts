import { describe, expect, it } from "vitest";
import {
	parsePricingOverrides,
	resolvePricingWithOverrides,
} from "./pricingCatalog";

const beforeCutover = Date.parse("2026-08-31T23:59:59.999Z");
const afterCutover = Date.parse("2026-09-01T00:00:00.000Z");

describe("pricing override catalog", () => {
	it("keeps built-in aliases available without local configuration", () => {
		const overrides = parsePricingOverrides("");
		expect(
			resolvePricingWithOverrides(
				"codex",
				"codex-auto-review",
				afterCutover,
				overrides,
			),
		).toMatchObject({
			model: "gpt-5.3-codex",
			alias: "codex-auto-review",
			source: "built-in",
		});
	});

	it("switches an alias at its UTC effective date", () => {
		const overrides = parsePricingOverrides(`
version = 1

[[models]]
provider = "codex"
model = "gpt-next"
input = 2
cached_input = 0.2
cache_write = 2
output = 12

[[aliases]]
provider = "codex"
alias = "codex-auto-review"
model = "gpt-next"
effective_from = "2026-09-01"
`);
		expect(
			resolvePricingWithOverrides(
				"codex",
				"codex-auto-review",
				beforeCutover,
				overrides,
			)?.model,
		).toBe("gpt-5.3-codex");
		expect(
			resolvePricingWithOverrides(
				"codex",
				"codex-auto-review",
				afterCutover,
				overrides,
			),
		).toMatchObject({ model: "gpt-next", alias: "codex-auto-review" });
	});

	it("lets a local model rule override a built-in only inside its window", () => {
		const overrides = parsePricingOverrides(`
[[models]]
provider = "codex"
model = "gpt-5.4"
effective_from = "2026-09-01"
effective_until = "2026-10-01"
input = 99
cached_input = 9.9
cache_write = 99
output = 199
`);
		expect(
			resolvePricingWithOverrides("codex", "gpt-5.4", beforeCutover, overrides)
				?.rates?.input,
		).toBe(2.5);
		expect(
			resolvePricingWithOverrides("codex", "gpt-5.4", afterCutover, overrides),
		).toMatchObject({ source: "local", rates: { input: 99 } });
		expect(
			resolvePricingWithOverrides(
				"codex",
				"gpt-5.4",
				Date.parse("2026-10-01T00:00:00.000Z"),
				overrides,
			)?.rates?.input,
		).toBe(2.5);
	});

	it("supports explicitly marking a model unpriced", () => {
		const overrides = parsePricingOverrides(`
[[models]]
provider = "codex"
model = "gpt-5.4"
unpriced = true
`);
		expect(
			resolvePricingWithOverrides("codex", "gpt-5.4", afterCutover, overrides),
		).toMatchObject({ source: "local", rates: null });
	});

	it("rejects overlapping local timelines and unknown alias targets", () => {
		expect(() =>
			parsePricingOverrides(`
[[models]]
provider = "codex"
model = "gpt-next"
effective_until = "2026-10-01"
input = 1
cached_input = 0.1
cache_write = 1
output = 5

[[models]]
provider = "codex"
model = "gpt-next"
effective_from = "2026-09-01"
input = 2
cached_input = 0.2
cache_write = 2
output = 10
`),
		).toThrow("overlap");
		expect(() =>
			parsePricingOverrides(`
[[aliases]]
provider = "codex"
alias = "future"
model = "does-not-exist"
`),
		).toThrow("unknown model");
	});

	it("rejects incomplete rates and inverted date windows", () => {
		expect(() =>
			parsePricingOverrides(`
[[models]]
provider = "codex"
model = "gpt-next"
input = 1
`),
		).toThrow("require input");
		expect(() =>
			parsePricingOverrides(`
[[models]]
provider = "codex"
model = "gpt-next"
effective_from = "2026-10-01"
effective_until = "2026-09-01"
input = 1
cached_input = 0.1
cache_write = 1
output = 5
`),
		).toThrow("must be after");
	});
});
