import { readFileSync, statSync } from "node:fs";
import { parse, TomlError } from "smol-toml";
import * as z from "zod";
import { writeFileAtomicSync } from "./atomicFile";
import { PRICING_OVERRIDES_PATH } from "./paths";

export type PricingTokenRates = {
	input: number;
	cachedInput: number;
	cacheWrite: number;
	/** Anthropic publishes a separate one-hour cache-write rate. */
	cacheWrite1h?: number;
	output: number;
	longContextThreshold?: number;
	longContextInputMultiplier?: number;
	longContextOutputMultiplier?: number;
};

export type PricingModelRule = {
	provider: string;
	model: string;
	rates: PricingTokenRates | null;
	effectiveFrom?: string;
	effectiveUntil?: string;
	note?: string;
};

export type PricingAliasRule = {
	provider: string;
	alias: string;
	model: string;
	effectiveFrom?: string;
	effectiveUntil?: string;
	note?: string;
};

export type PricingOverrides = {
	version: 1;
	models: PricingModelRule[];
	aliases: PricingAliasRule[];
};

export type PricingCatalogSource = "built-in" | "local";

export type PricingCatalogModelView = PricingModelRule & {
	source: PricingCatalogSource;
};

export type PricingCatalogAliasView = PricingAliasRule & {
	source: PricingCatalogSource;
};

export type PricingCatalogState = {
	path: string;
	exists: boolean;
	text: string;
	error: string | null;
	models: PricingCatalogModelView[];
	aliases: PricingCatalogAliasView[];
};

export type ResolvedPricing = PricingModelRule & {
	source: PricingCatalogSource;
	requestedModel: string;
	alias: string | null;
};

const LONG_CONTEXT = {
	longContextThreshold: 272_000,
	longContextInputMultiplier: 2,
	longContextOutputMultiplier: 1.5,
} as const;

export const BUILTIN_PRICING_MODELS: readonly PricingModelRule[] = [
	{
		provider: "codex",
		model: "gpt-5.6-sol",
		rates: {
			input: 5,
			cachedInput: 0.5,
			cacheWrite: 6.25,
			output: 30,
			...LONG_CONTEXT,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.6-terra",
		rates: {
			input: 2.5,
			cachedInput: 0.25,
			cacheWrite: 3.125,
			output: 15,
			...LONG_CONTEXT,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.6-luna",
		rates: {
			input: 1,
			cachedInput: 0.1,
			cacheWrite: 1.25,
			output: 6,
			...LONG_CONTEXT,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.5",
		rates: {
			input: 5,
			cachedInput: 0.5,
			cacheWrite: 5,
			output: 30,
			...LONG_CONTEXT,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.4",
		rates: {
			input: 2.5,
			cachedInput: 0.25,
			cacheWrite: 2.5,
			output: 15,
			...LONG_CONTEXT,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.4-mini",
		rates: {
			input: 0.75,
			cachedInput: 0.075,
			cacheWrite: 0.75,
			output: 4.5,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.3-codex",
		rates: {
			input: 1.75,
			cachedInput: 0.175,
			cacheWrite: 1.75,
			output: 14,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.2-codex",
		rates: {
			input: 1.75,
			cachedInput: 0.175,
			cacheWrite: 1.75,
			output: 14,
		},
	},
	{
		provider: "codex",
		model: "gpt-5.3-codex-spark",
		rates: null,
		note: "Research preview; OpenAI has not published a finalized rate.",
	},
	{
		provider: "claude",
		model: "claude-fable-5",
		rates: {
			input: 10,
			cachedInput: 1,
			cacheWrite: 12.5,
			cacheWrite1h: 20,
			output: 50,
		},
	},
	{
		provider: "claude",
		model: "claude-mythos-5",
		rates: {
			input: 10,
			cachedInput: 1,
			cacheWrite: 12.5,
			cacheWrite1h: 20,
			output: 50,
		},
	},
	...(
		[
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
		] as const
	).map(
		(model): PricingModelRule => ({
			provider: "claude",
			model,
			rates: {
				input: 5,
				cachedInput: 0.5,
				cacheWrite: 6.25,
				cacheWrite1h: 10,
				output: 25,
			},
		}),
	),
	...(["claude-opus-4-1", "claude-opus-4"] as const).map(
		(model): PricingModelRule => ({
			provider: "claude",
			model,
			rates: {
				input: 15,
				cachedInput: 1.5,
				cacheWrite: 18.75,
				cacheWrite1h: 30,
				output: 75,
			},
		}),
	),
	{
		provider: "claude",
		model: "claude-sonnet-5",
		effectiveUntil: "2026-09-01",
		rates: {
			input: 2,
			cachedInput: 0.2,
			cacheWrite: 2.5,
			cacheWrite1h: 4,
			output: 10,
		},
		note: "Introductory pricing through August 31, 2026.",
	},
	{
		provider: "claude",
		model: "claude-sonnet-5",
		effectiveFrom: "2026-09-01",
		rates: {
			input: 3,
			cachedInput: 0.3,
			cacheWrite: 3.75,
			cacheWrite1h: 6,
			output: 15,
		},
	},
	...(
		["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"] as const
	).map(
		(model): PricingModelRule => ({
			provider: "claude",
			model,
			rates: {
				input: 3,
				cachedInput: 0.3,
				cacheWrite: 3.75,
				cacheWrite1h: 6,
				output: 15,
			},
		}),
	),
	{
		provider: "claude",
		model: "claude-haiku-4-5",
		rates: {
			input: 1,
			cachedInput: 0.1,
			cacheWrite: 1.25,
			cacheWrite1h: 2,
			output: 5,
		},
	},
	{
		provider: "claude",
		model: "claude-haiku-3-5",
		rates: {
			input: 0.8,
			cachedInput: 0.08,
			cacheWrite: 1,
			cacheWrite1h: 1.6,
			output: 4,
		},
	},
];

export const BUILTIN_PRICING_ALIASES: readonly PricingAliasRule[] = [
	{
		provider: "codex",
		alias: "gpt-5.6",
		model: "gpt-5.6-sol",
	},
	{
		provider: "codex",
		alias: "codex-auto-review",
		model: "gpt-5.3-codex",
		note: "Codex Code Review uses GPT-5.3-Codex.",
	},
];

const EffectiveDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
	.refine((value) => {
		const parsed = Date.parse(`${value}T00:00:00.000Z`);
		return (
			Number.isFinite(parsed) &&
			new Date(parsed).toISOString().startsWith(value)
		);
	}, "Expected a real calendar date");

const RateSchema = z.number().finite().nonnegative();
const CommonRuleSchema = z.object({
	provider: z.enum(["codex", "claude"]),
	effective_from: EffectiveDateSchema.optional(),
	effective_until: EffectiveDateSchema.optional(),
	note: z.string().trim().min(1).optional(),
});

const ModelOverrideSchema = CommonRuleSchema.extend({
	model: z.string().trim().min(1),
	unpriced: z.boolean().optional().default(false),
	input: RateSchema.optional(),
	cached_input: RateSchema.optional(),
	cache_write: RateSchema.optional(),
	cache_write_1h: RateSchema.optional(),
	output: RateSchema.optional(),
	long_context_threshold: z.number().int().positive().optional(),
	long_context_input_multiplier: z.number().positive().optional(),
	long_context_output_multiplier: z.number().positive().optional(),
}).superRefine((value, ctx) => {
	const rates = [
		value.input,
		value.cached_input,
		value.cache_write,
		value.output,
	];
	if (!value.unpriced && rates.some((rate) => rate === undefined)) {
		ctx.addIssue({
			code: "custom",
			message:
				"Priced model overrides require input, cached_input, cache_write, and output",
		});
	}
	if (value.unpriced && rates.some((rate) => rate !== undefined)) {
		ctx.addIssue({
			code: "custom",
			message: "An unpriced model override cannot also define token rates",
		});
	}
});

const AliasOverrideSchema = CommonRuleSchema.extend({
	alias: z.string().trim().min(1),
	model: z.string().trim().min(1),
});

const PricingOverrideFileSchema = z.object({
	version: z.literal(1).default(1),
	models: z.array(ModelOverrideSchema).default([]),
	aliases: z.array(AliasOverrideSchema).default([]),
});

export const EMPTY_PRICING_OVERRIDES_TOML = `# Hlid pricing overrides
# Rates are USD per million tokens. Dates are UTC; effective_until is exclusive.
# Built-in prices remain read-only and apply whenever no active local rule matches.
version = 1

# [[models]]
# provider = "codex"
# model = "gpt-example"
# effective_from = "2026-09-01"
# input = 1.00
# cached_input = 0.10
# cache_write = 1.00
# output = 5.00

# [[aliases]]
# provider = "codex"
# alias = "codex-auto-review"
# model = "gpt-example"
# effective_from = "2026-09-01"
`;

function dateMs(value: string | undefined, fallback: number): number {
	return value ? Date.parse(`${value}T00:00:00.000Z`) : fallback;
}

function assertDateRange(
	rule: { effectiveFrom?: string; effectiveUntil?: string },
	label: string,
): void {
	if (
		dateMs(rule.effectiveFrom, Number.NEGATIVE_INFINITY) >=
		dateMs(rule.effectiveUntil, Number.POSITIVE_INFINITY)
	) {
		throw new Error(`${label} effective_until must be after effective_from`);
	}
}

function intervalsOverlap(
	a: { effectiveFrom?: string; effectiveUntil?: string },
	b: { effectiveFrom?: string; effectiveUntil?: string },
): boolean {
	return (
		dateMs(a.effectiveFrom, Number.NEGATIVE_INFINITY) <
			dateMs(b.effectiveUntil, Number.POSITIVE_INFINITY) &&
		dateMs(b.effectiveFrom, Number.NEGATIVE_INFINITY) <
			dateMs(a.effectiveUntil, Number.POSITIVE_INFINITY)
	);
}

function assertNoLocalOverlap<
	T extends {
		provider: string;
		effectiveFrom?: string;
		effectiveUntil?: string;
	},
>(rules: T[], key: (rule: T) => string, kind: string): void {
	for (let index = 0; index < rules.length; index++) {
		for (let other = index + 1; other < rules.length; other++) {
			const left = rules[index];
			const right = rules[other];
			if (
				left.provider.toLowerCase() === right.provider.toLowerCase() &&
				key(left).toLowerCase() === key(right).toLowerCase() &&
				intervalsOverlap(left, right)
			) {
				throw new Error(
					`Local ${kind} rules overlap for ${left.provider}:${key(left)}`,
				);
			}
		}
	}
}

function applyOverrideMetadata<
	T extends {
		effectiveFrom?: string;
		effectiveUntil?: string;
		note?: string;
	},
>(
	result: T,
	rule: {
		effective_from?: string;
		effective_until?: string;
		note?: string;
	},
): void {
	if (rule.effective_from) result.effectiveFrom = rule.effective_from;
	if (rule.effective_until) result.effectiveUntil = rule.effective_until;
	if (rule.note) result.note = rule.note;
}

function normalizeOverrides(
	parsed: z.infer<typeof PricingOverrideFileSchema>,
): PricingOverrides {
	const models = parsed.models.map((rule): PricingModelRule => {
		const result: PricingModelRule = {
			provider: rule.provider,
			model: rule.model,
			rates: rule.unpriced
				? null
				: {
						input: rule.input as number,
						cachedInput: rule.cached_input as number,
						cacheWrite: rule.cache_write as number,
						output: rule.output as number,
						...(rule.cache_write_1h === undefined
							? {}
							: { cacheWrite1h: rule.cache_write_1h }),
						...(rule.long_context_threshold === undefined
							? {}
							: { longContextThreshold: rule.long_context_threshold }),
						...(rule.long_context_input_multiplier === undefined
							? {}
							: {
									longContextInputMultiplier:
										rule.long_context_input_multiplier,
								}),
						...(rule.long_context_output_multiplier === undefined
							? {}
							: {
									longContextOutputMultiplier:
										rule.long_context_output_multiplier,
								}),
					},
		};
		applyOverrideMetadata(result, rule);
		assertDateRange(result, `Model ${rule.provider}:${rule.model}`);
		return result;
	});
	const aliases = parsed.aliases.map((rule): PricingAliasRule => {
		const result: PricingAliasRule = {
			provider: rule.provider,
			alias: rule.alias,
			model: rule.model,
		};
		applyOverrideMetadata(result, rule);
		assertDateRange(result, `Alias ${rule.provider}:${rule.alias}`);
		return result;
	});
	assertNoLocalOverlap(models, (rule) => rule.model, "model");
	assertNoLocalOverlap(aliases, (rule) => rule.alias, "alias");
	const targets = new Set(
		[...BUILTIN_PRICING_MODELS, ...models].map(
			(rule) => `${rule.provider.toLowerCase()}:${rule.model.toLowerCase()}`,
		),
	);
	for (const alias of aliases) {
		if (
			!targets.has(
				`${alias.provider.toLowerCase()}:${alias.model.toLowerCase()}`,
			)
		) {
			throw new Error(
				`Alias ${alias.provider}:${alias.alias} targets unknown model ${alias.model}`,
			);
		}
	}
	return { version: 1, models, aliases };
}

export function parsePricingOverrides(text: string): PricingOverrides {
	try {
		const raw = text.trim() ? parse(text) : {};
		return normalizeOverrides(PricingOverrideFileSchema.parse(raw));
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new Error(`Invalid pricing overrides:\n${z.prettifyError(error)}`);
		}
		if (error instanceof TomlError) {
			throw new Error(`Invalid pricing override TOML:\n${error.message}`);
		}
		throw error;
	}
}

function appliesAt(
	rule: { effectiveFrom?: string; effectiveUntil?: string },
	atMs: number,
): boolean {
	return (
		atMs >= dateMs(rule.effectiveFrom, Number.NEGATIVE_INFINITY) &&
		atMs < dateMs(rule.effectiveUntil, Number.POSITIVE_INFINITY)
	);
}

function modelMatches(requested: string, configured: string): boolean {
	return requested === configured || requested.startsWith(`${configured}-20`);
}

function newestRule<T extends { effectiveFrom?: string }>(
	rules: T[],
): T | null {
	return (
		[...rules].sort(
			(a, b) =>
				dateMs(b.effectiveFrom, Number.NEGATIVE_INFINITY) -
				dateMs(a.effectiveFrom, Number.NEGATIVE_INFINITY),
		)[0] ?? null
	);
}

function findModelRule(
	provider: string,
	model: string,
	atMs: number,
	overrides: PricingOverrides,
): PricingCatalogModelView | null {
	const normalizedProvider = provider.toLowerCase();
	const requested = model.toLowerCase();
	for (const [rules, source] of [
		[overrides.models, "local"],
		[BUILTIN_PRICING_MODELS, "built-in"],
	] as const) {
		const matches = rules
			.filter(
				(rule) =>
					rule.provider.toLowerCase() === normalizedProvider &&
					modelMatches(requested, rule.model.toLowerCase()) &&
					appliesAt(rule, atMs),
			)
			.sort((a, b) => b.model.length - a.model.length);
		const longest = matches[0]?.model.length;
		const selected = newestRule(
			longest === undefined
				? []
				: matches.filter((rule) => rule.model.length === longest),
		);
		if (selected) return { ...selected, source };
	}
	return null;
}

function findAliasRule(
	provider: string,
	alias: string,
	atMs: number,
	overrides: PricingOverrides,
): PricingCatalogAliasView | null {
	const normalizedProvider = provider.toLowerCase();
	const normalizedAlias = alias.toLowerCase();
	for (const [rules, source] of [
		[overrides.aliases, "local"],
		[BUILTIN_PRICING_ALIASES, "built-in"],
	] as const) {
		const selected = newestRule(
			rules.filter(
				(rule) =>
					rule.provider.toLowerCase() === normalizedProvider &&
					rule.alias.toLowerCase() === normalizedAlias &&
					appliesAt(rule, atMs),
			),
		);
		if (selected) return { ...selected, source };
	}
	return null;
}

export function resolvePricingWithOverrides(
	provider: string,
	model: string | null | undefined,
	atMs: number,
	overrides: PricingOverrides,
): ResolvedPricing | null {
	if (!model?.trim()) return null;
	const requestedModel = model.trim();
	const direct = findModelRule(provider, requestedModel, atMs, overrides);
	if (direct) {
		return { ...direct, requestedModel, alias: null };
	}
	const alias = findAliasRule(provider, requestedModel, atMs, overrides);
	if (!alias) return null;
	const target = findModelRule(provider, alias.model, atMs, overrides);
	return target
		? {
				...target,
				requestedModel,
				alias: alias.alias,
				note: alias.note ?? target.note,
			}
		: null;
}

type OverrideSnapshot = {
	mtimeMs: number | null;
	size: number | null;
	exists: boolean;
	text: string;
	overrides: PricingOverrides;
	error: string | null;
};

const EMPTY_OVERRIDES: PricingOverrides = {
	version: 1,
	models: [],
	aliases: [],
};
let overrideCache: OverrideSnapshot | null = null;

function loadOverrideSnapshot(): OverrideSnapshot {
	try {
		const stat = statSync(PRICING_OVERRIDES_PATH);
		if (
			overrideCache?.exists &&
			overrideCache.mtimeMs === stat.mtimeMs &&
			overrideCache.size === stat.size
		) {
			return overrideCache;
		}
		const text = readFileSync(PRICING_OVERRIDES_PATH, "utf8");
		try {
			overrideCache = {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				exists: true,
				text,
				overrides: parsePricingOverrides(text),
				error: null,
			};
		} catch (error) {
			overrideCache = {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				exists: true,
				text,
				overrides: EMPTY_OVERRIDES,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		return overrideCache;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			if (!overrideCache || overrideCache.exists) {
				overrideCache = {
					mtimeMs: null,
					size: null,
					exists: false,
					text: EMPTY_PRICING_OVERRIDES_TOML,
					overrides: EMPTY_OVERRIDES,
					error: null,
				};
			}
			return overrideCache;
		}
		overrideCache = {
			mtimeMs: null,
			size: null,
			exists: true,
			text: overrideCache?.text ?? EMPTY_PRICING_OVERRIDES_TOML,
			overrides: EMPTY_OVERRIDES,
			error: `Failed to read pricing overrides: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
		return overrideCache;
	}
}

export function resolvePricing(
	provider: string,
	model: string | null | undefined,
	atMs = Date.now(),
): ResolvedPricing | null {
	return resolvePricingWithOverrides(
		provider,
		model,
		atMs,
		loadOverrideSnapshot().overrides,
	);
}

function catalogViews(overrides: PricingOverrides): {
	models: PricingCatalogModelView[];
	aliases: PricingCatalogAliasView[];
} {
	const byIdentity = <
		T extends {
			provider: string;
			effectiveFrom?: string;
			effectiveUntil?: string;
		},
	>(
		left: T,
		right: T,
		leftKey: string,
		rightKey: string,
	) =>
		left.provider.localeCompare(right.provider) ||
		leftKey.localeCompare(rightKey) ||
		(left.effectiveFrom ?? "").localeCompare(right.effectiveFrom ?? "") ||
		(left.effectiveUntil ?? "").localeCompare(right.effectiveUntil ?? "");
	return {
		models: [
			...BUILTIN_PRICING_MODELS.map((rule) => ({
				...rule,
				source: "built-in" as const,
			})),
			...overrides.models.map((rule) => ({
				...rule,
				source: "local" as const,
			})),
		].sort((a, b) => byIdentity(a, b, a.model, b.model)),
		aliases: [
			...BUILTIN_PRICING_ALIASES.map((rule) => ({
				...rule,
				source: "built-in" as const,
			})),
			...overrides.aliases.map((rule) => ({
				...rule,
				source: "local" as const,
			})),
		].sort((a, b) => byIdentity(a, b, a.alias, b.alias)),
	};
}

export function getPricingCatalogState(): PricingCatalogState {
	const snapshot = loadOverrideSnapshot();
	const catalog = catalogViews(snapshot.overrides);
	return {
		path: PRICING_OVERRIDES_PATH,
		exists: snapshot.exists,
		text: snapshot.text,
		error: snapshot.error,
		...catalog,
	};
}

export function savePricingOverrides(text: string): PricingCatalogState {
	parsePricingOverrides(text);
	const normalized = text.trim() ? `${text.trimEnd()}\n` : "version = 1\n";
	writeFileAtomicSync(PRICING_OVERRIDES_PATH, normalized, {
		encoding: "utf8",
		mode: 0o600,
		createParent: true,
	});
	overrideCache = null;
	return getPricingCatalogState();
}

/** @internal */
export function resetPricingCatalogCacheForTesting(): void {
	overrideCache = null;
}
