import type { DataDomain } from "./dataRevision";

const ROUTE_DATA_DOMAINS: ReadonlyArray<{
	match: (pathname: string) => boolean;
	domains: readonly DataDomain[];
}> = [
	{
		match: (pathname) => pathname === "/",
		domains: ["stats", "sessions", "vault", "providers", "mcp", "config"],
	},
	{
		match: (pathname) => pathname.startsWith("/ledger"),
		domains: ["stats", "sessions", "providers"],
	},
	{
		match: (pathname) => pathname.startsWith("/vault"),
		domains: ["vault", "config"],
	},
	{
		match: (pathname) => pathname.startsWith("/raven"),
		domains: ["providers", "config"],
	},
	{
		match: (pathname) => pathname.startsWith("/einherjar"),
		domains: ["providers", "config"],
	},
	{
		match: (pathname) => pathname.startsWith("/forge"),
		domains: ["providers", "config", "storage", "mcp"],
	},
];

/** Whether a server revision change affects the loader for the visible route. */
export function shouldRevalidateRouteData(
	pathname: string,
	changedDomains: readonly DataDomain[],
): boolean {
	const relevant = ROUTE_DATA_DOMAINS.find((entry) => entry.match(pathname));
	return Boolean(
		relevant &&
			changedDomains.some((domain) => relevant.domains.includes(domain)),
	);
}
