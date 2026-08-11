import type {
	HlidApiEndpoint,
	HlidApiIndex,
	HlidApiMethod,
} from "../lib/apiIndex";
import { revisionFor } from "./hlidHelpValue";

export const MAX_HLID_API_RESULTS = 50;
export const DEFAULT_HLID_API_RESULTS = 20;
export const MAX_HLID_API_RESPONSE_CHARS = 12_000;

export type HlidApiDiscoveryInput = {
	query?: string;
	method?: HlidApiMethod;
	scope?: "data" | "ui";
	limit?: number;
	cursor?: string;
};

type HlidApiCursor = {
	contractVersion: 1;
	revision: string;
	offset: number;
	query?: string;
	method?: HlidApiMethod;
	scope?: "data" | "ui";
};

type HlidApiDiscoveryResult = {
	contractVersion: 1;
	revision: string;
	description: string;
	execution: string;
	apiBaseUrl: string;
	uiBaseUrl: string;
	total: number;
	returned: number;
	truncated: boolean;
	nextCursor?: string;
	endpoints: HlidApiEndpoint[];
};

function encodeCursor(cursor: HlidApiCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): HlidApiCursor {
	try {
		const cursor = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<HlidApiCursor>;
		if (
			cursor.contractVersion !== 1 ||
			typeof cursor.revision !== "string" ||
			typeof cursor.offset !== "number" ||
			!Number.isInteger(cursor.offset) ||
			cursor.offset < 0
		) {
			throw new Error("invalid cursor");
		}
		return cursor as HlidApiCursor;
	} catch {
		throw new Error("Hlid API cursor is invalid. Start a new search.");
	}
}

function matchesQuery(endpoint: HlidApiEndpoint, query: string): boolean {
	if (!query) return true;
	return `${endpoint.id ?? ""} ${endpoint.method} ${endpoint.path} ${endpoint.server} ${endpoint.desc} ${(endpoint.tags ?? []).join(" ")} ${endpoint.safety ?? ""} ${endpoint.agent_access ?? ""}`
		.toLowerCase()
		.includes(query);
}

function serializeWithinBudget(
	base: Omit<
		HlidApiDiscoveryResult,
		"returned" | "truncated" | "nextCursor" | "endpoints"
	>,
	matches: HlidApiEndpoint[],
	requestedLimit: number,
	offset: number,
	cursorFilters: Omit<HlidApiCursor, "contractVersion" | "revision" | "offset">,
): string {
	const selected: HlidApiEndpoint[] = [];
	for (const endpoint of matches.slice(offset, offset + requestedLimit)) {
		const candidate = [...selected, endpoint];
		const nextOffset = offset + candidate.length;
		const serialized = JSON.stringify({
			...base,
			returned: candidate.length,
			truncated: nextOffset < matches.length,
			...(nextOffset < matches.length
				? {
						nextCursor: encodeCursor({
							contractVersion: 1,
							revision: base.revision,
							offset: nextOffset,
							...cursorFilters,
						}),
					}
				: {}),
			endpoints: candidate,
		});
		if (serialized.length > MAX_HLID_API_RESPONSE_CHARS) break;
		selected.push(endpoint);
	}
	if (selected.length === 0 && offset < matches.length) {
		throw new Error(
			"One Hlid API catalog entry exceeds the response budget. Narrow the search filters.",
		);
	}
	const nextOffset = offset + selected.length;
	return JSON.stringify({
		...base,
		returned: selected.length,
		truncated: nextOffset < matches.length,
		...(nextOffset < matches.length
			? {
					nextCursor: encodeCursor({
						contractVersion: 1,
						revision: base.revision,
						offset: nextOffset,
						...cursorFilters,
					}),
				}
			: {}),
		endpoints: selected,
	});
}

export function buildHlidApiDiscoveryResponse(
	index: HlidApiIndex,
	input: HlidApiDiscoveryInput,
): string {
	const revision = revisionFor(index.endpoints, 1);
	const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
	if (cursor && cursor.revision !== revision) {
		throw new Error("Hlid API catalog changed. Start a new search.");
	}
	const requestedQuery = input.query?.trim().toLowerCase();
	const query = requestedQuery ?? cursor?.query ?? "";
	const method = input.method ?? cursor?.method;
	const scope = input.scope ?? cursor?.scope;
	if (
		cursor &&
		((requestedQuery !== undefined &&
			requestedQuery !== (cursor.query ?? "")) ||
			(input.method !== undefined && input.method !== cursor.method) ||
			(input.scope !== undefined && input.scope !== cursor.scope))
	) {
		throw new Error("Hlid API cursor does not match the supplied filters.");
	}
	const requestedLimit = Math.min(
		MAX_HLID_API_RESULTS,
		Math.max(1, input.limit ?? DEFAULT_HLID_API_RESULTS),
	);
	const matches = index.endpoints.filter((endpoint) => {
		if (method && endpoint.method !== method) return false;
		if (scope === "data" && endpoint.server !== "api") return false;
		if (scope === "ui" && endpoint.server !== "ui") return false;
		return matchesQuery(endpoint, query);
	});
	return serializeWithinBudget(
		{
			contractVersion: 1,
			revision,
			description: index.description,
			execution:
				"Catalog entries are not an authenticated provider bridge. Prefer typed Hlid tools; direct calls require host reachability and Hlid authentication.",
			apiBaseUrl: `http://127.0.0.1:${index.api_port}`,
			uiBaseUrl: `http://127.0.0.1:${index.ui_port}`,
			total: matches.length,
		},
		matches,
		requestedLimit,
		cursor?.offset ?? 0,
		{
			...(query ? { query } : {}),
			...(method ? { method } : {}),
			...(scope ? { scope } : {}),
		},
	);
}
