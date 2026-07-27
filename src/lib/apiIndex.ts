export const HLID_API_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export const HLID_API_SERVERS = ["api", "ui"] as const;

export type HlidApiMethod = (typeof HLID_API_METHODS)[number];
export type HlidApiServer = (typeof HLID_API_SERVERS)[number];

export type HlidApiEndpoint = {
	method: HlidApiMethod;
	path: string;
	server: HlidApiServer;
	desc: string;
};

export type HlidApiIndex = {
	description: string;
	api_port: number;
	ui_port: number;
	endpoints: HlidApiEndpoint[];
};

function isPort(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 65_535
	);
}

function isEndpoint(value: unknown): value is HlidApiEndpoint {
	if (!value || typeof value !== "object") return false;
	const endpoint = value as Record<string, unknown>;
	return (
		HLID_API_METHODS.some((method) => method === endpoint.method) &&
		HLID_API_SERVERS.some((server) => server === endpoint.server) &&
		typeof endpoint.path === "string" &&
		endpoint.path.startsWith("/") &&
		typeof endpoint.desc === "string"
	);
}

export function parseHlidApiIndex(value: unknown): HlidApiIndex {
	if (!value || typeof value !== "object") {
		throw new Error("Hlid returned an invalid API catalog.");
	}
	const index = value as Record<string, unknown>;
	if (
		typeof index.description !== "string" ||
		!isPort(index.api_port) ||
		!isPort(index.ui_port) ||
		!Array.isArray(index.endpoints) ||
		!index.endpoints.every(isEndpoint)
	) {
		throw new Error("Hlid returned an invalid API catalog.");
	}
	return index as HlidApiIndex;
}
