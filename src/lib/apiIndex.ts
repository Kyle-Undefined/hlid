export const HLID_API_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export const HLID_API_SERVERS = ["api", "ui"] as const;

export type HlidApiMethod = (typeof HLID_API_METHODS)[number];
export type HlidApiServer = (typeof HLID_API_SERVERS)[number];

export type HlidApiEndpoint = {
	method: HlidApiMethod;
	path: string;
	server: HlidApiServer;
	desc: string;
	/** Stable catalog identity derived from method and path. */
	id?: string;
	/** Coarse task labels for precise discovery. */
	tags?: string[];
	/** Mutation risk, independent of authentication and approval policy. */
	safety?: "observational" | "mutating" | "destructive";
	/** Whether provider agents should prefer a curated typed Hlid tool. */
	agent_access?: "direct-auth-required" | "typed-tool-preferred";
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
		typeof endpoint.desc === "string" &&
		(endpoint.id === undefined || typeof endpoint.id === "string") &&
		(endpoint.tags === undefined ||
			(Array.isArray(endpoint.tags) &&
				endpoint.tags.every((tag) => typeof tag === "string"))) &&
		(endpoint.safety === undefined ||
			endpoint.safety === "observational" ||
			endpoint.safety === "mutating" ||
			endpoint.safety === "destructive") &&
		(endpoint.agent_access === undefined ||
			endpoint.agent_access === "direct-auth-required" ||
			endpoint.agent_access === "typed-tool-preferred")
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
