import type {
	HlidApiEndpoint,
	HlidApiIndex,
	HlidApiMethod,
} from "../lib/apiIndex";

export const MAX_HLID_API_RESULTS = 50;
export const DEFAULT_HLID_API_RESULTS = 20;
export const MAX_HLID_API_RESPONSE_CHARS = 12_000;

export type HlidApiDiscoveryInput = {
	query?: string;
	method?: HlidApiMethod;
	scope?: "data" | "ui";
	limit?: number;
};

type HlidApiDiscoveryResult = {
	description: string;
	apiBaseUrl: string;
	uiBaseUrl: string;
	total: number;
	returned: number;
	truncated: boolean;
	endpoints: HlidApiEndpoint[];
};

function matchesQuery(endpoint: HlidApiEndpoint, query: string): boolean {
	if (!query) return true;
	return `${endpoint.method} ${endpoint.path} ${endpoint.server} ${endpoint.desc}`
		.toLowerCase()
		.includes(query);
}

function serializeWithinBudget(
	base: Omit<HlidApiDiscoveryResult, "returned" | "truncated" | "endpoints">,
	matches: HlidApiEndpoint[],
	requestedLimit: number,
): string {
	const selected: HlidApiEndpoint[] = [];
	for (const endpoint of matches.slice(0, requestedLimit)) {
		const candidate = [...selected, endpoint];
		const serialized = JSON.stringify({
			...base,
			returned: candidate.length,
			truncated: candidate.length < matches.length,
			endpoints: candidate,
		});
		if (serialized.length > MAX_HLID_API_RESPONSE_CHARS) break;
		selected.push(endpoint);
	}
	return JSON.stringify({
		...base,
		returned: selected.length,
		truncated: selected.length < matches.length,
		endpoints: selected,
	});
}

export function buildHlidApiDiscoveryResponse(
	index: HlidApiIndex,
	input: HlidApiDiscoveryInput,
): string {
	const query = input.query?.trim().toLowerCase() ?? "";
	const requestedLimit = Math.min(
		MAX_HLID_API_RESULTS,
		Math.max(1, input.limit ?? DEFAULT_HLID_API_RESULTS),
	);
	const matches = index.endpoints.filter((endpoint) => {
		if (input.method && endpoint.method !== input.method) return false;
		if (input.scope === "data" && endpoint.server !== "api") return false;
		if (input.scope === "ui" && endpoint.server !== "ui") return false;
		return matchesQuery(endpoint, query);
	});
	return serializeWithinBudget(
		{
			description: index.description,
			apiBaseUrl: `http://127.0.0.1:${index.api_port}`,
			uiBaseUrl: `http://127.0.0.1:${index.ui_port}`,
			total: matches.length,
		},
		matches,
		requestedLimit,
	);
}
