import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export type AcpSelectValue = {
	value: string;
	name: string;
	description?: string | null;
};

export function findAcpSessionConfigOption(
	options: readonly SessionConfigOption[],
	category: string,
	namePattern: RegExp,
): SessionConfigOption | undefined {
	return (
		options.find((option) => option.category === category) ??
		options.find((option) => namePattern.test(`${option.id} ${option.name}`))
	);
}

/** Flatten grouped ACP select values while keeping provider-owned identifiers opaque. */
export function acpSelectValues(
	option: SessionConfigOption,
	limit = Number.MAX_SAFE_INTEGER,
): { values: AcpSelectValue[]; truncated: boolean } {
	if (option.type !== "select") return { values: [], truncated: false };
	const values: AcpSelectValue[] = [];
	for (const entry of option.options) {
		const candidates = "group" in entry ? entry.options : [entry];
		for (const candidate of candidates) {
			if (values.length >= limit) return { values, truncated: true };
			values.push({
				value: candidate.value,
				name: candidate.name,
				description: candidate.description,
			});
		}
	}
	return { values, truncated: false };
}
