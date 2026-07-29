import { type HlidConfig, HlidConfigSchema } from "#/config";

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends readonly unknown[]
		? T[K]
		: T[K] extends object
			? DeepPartial<T[K]>
			: T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
	const result: Record<string, unknown> = {
		...(base as Record<string, unknown>),
	};
	for (const [key, value] of Object.entries(
		overrides as Record<string, unknown>,
	)) {
		if (value === undefined) continue;
		const current = result[key];
		result[key] =
			isPlainObject(current) && isPlainObject(value)
				? deepMerge(current, value)
				: value;
	}
	return result as T;
}

/**
 * Full HlidConfig built from schema defaults with deep overrides applied.
 * Arrays are replaced, not merged. Stays in sync with HlidConfigSchema —
 * new config fields never require fixture updates.
 */
export function makeConfig(
	overrides: DeepPartial<HlidConfig> = {},
): HlidConfig {
	return deepMerge(HlidConfigSchema.parse({}), overrides);
}
