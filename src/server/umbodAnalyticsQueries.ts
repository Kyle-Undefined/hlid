import type { Umbod } from "@umbod/core";
import { includesSearchText } from "#/lib/search";
import type { UmbodAnalyticsSnapshot } from "./umbodAnalyticsWorkerProtocol";

async function fetchJson(umbod: Umbod, url: URL | string): Promise<unknown> {
	const response = await Promise.resolve(
		umbod.fetch(new Request(typeof url === "string" ? url : url.href)),
	);
	if (!response) throw new Error("Umbod analytics endpoint is unavailable");
	const body = (await response.json()) as unknown;
	if (!response.ok) {
		const message =
			body &&
			typeof body === "object" &&
			"error" in body &&
			typeof body.error === "string"
				? body.error
				: `Umbod analytics failed with status ${response.status}`;
		throw new Error(message);
	}
	return body;
}

export async function readUmbodAnalyticsFromEngine(
	umbod: Umbod,
): Promise<UmbodAnalyticsSnapshot> {
	return {
		tools: await fetchJson(
			umbod,
			"http://hlid/api/analytics/tools?recentDays=14",
		),
		rules: await fetchJson(umbod, "http://hlid/api/analytics/rules"),
	};
}

type UmbodCallPage = {
	entries: Array<{ command?: string } & Record<string, unknown>>;
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
};

async function normalizedCalls(
	umbod: Umbod,
	searchParams: URLSearchParams,
	search: string,
): Promise<UmbodCallPage> {
	const requestedPage = Math.max(Number(searchParams.get("page")) || 1, 1);
	const requestedPageSize = Math.min(
		Math.max(Number(searchParams.get("pageSize")) || 50, 1),
		200,
	);
	const url = new URL("http://hlid/api/analytics/calls");
	for (const [key, value] of searchParams) {
		if (!["view", "search", "page", "pageSize"].includes(key))
			url.searchParams.set(key, value);
	}
	url.searchParams.set("pageSize", "200");

	const matches: UmbodCallPage["entries"] = [];
	let sourcePage = 1;
	let sourcePages = 1;
	do {
		url.searchParams.set("page", String(sourcePage));
		const page = (await fetchJson(umbod, url)) as UmbodCallPage;
		matches.push(
			...page.entries.filter((entry) =>
				includesSearchText(entry.command ?? "", search),
			),
		);
		sourcePages = Math.max(page.totalPages, 1);
		sourcePage += 1;
	} while (sourcePage <= sourcePages);

	const offset = (requestedPage - 1) * requestedPageSize;
	return {
		entries: matches.slice(offset, offset + requestedPageSize),
		page: requestedPage,
		pageSize: requestedPageSize,
		total: matches.length,
		totalPages: Math.max(Math.ceil(matches.length / requestedPageSize), 1),
	};
}

export async function readUmbodCallsFromEngine(
	umbod: Umbod,
	searchParams: URLSearchParams,
): Promise<unknown> {
	const search = searchParams.get("search")?.trim();
	if (search) return normalizedCalls(umbod, searchParams, search);
	const url = new URL("http://hlid/api/analytics/calls");
	for (const [key, value] of searchParams) {
		if (key !== "view") url.searchParams.set(key, value);
	}
	return fetchJson(umbod, url);
}
