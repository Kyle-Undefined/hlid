function canonicalRegistryValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalRegistryValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalRegistryValue(item)]),
		);
	}
	return value;
}

export function revisionFor(value: unknown, contractVersion: number): string {
	const serialized = JSON.stringify(canonicalRegistryValue(value));
	let hash = 0x811c9dc5;
	for (let index = 0; index < serialized.length; index += 1) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `v${contractVersion}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function boundedValue(
	value: string | undefined,
	maxChars: number,
): string {
	const trimmed = value?.trim();
	if (!trimmed) return "unspecified";
	return trimmed.length <= maxChars
		? trimmed
		: `${trimmed.slice(0, maxChars - 1)}…`;
}
