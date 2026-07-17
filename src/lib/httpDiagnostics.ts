function safeSegment(segment: string): string {
	if (!segment) return segment;
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			segment,
		) ||
		/^[0-9a-f]{24,}$/i.test(segment) ||
		/^\d{6,}$/.test(segment) ||
		segment.length > 48 ||
		segment.includes("%")
	) {
		return ":id";
	}
	return segment.replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 48);
}

/** A query-free, identifier-scrubbed route suitable for persistent logs. */
export function safeRequestPath(input: Request | URL | string): string {
	try {
		const url =
			input instanceof Request
				? new URL(input.url)
				: input instanceof URL
					? input
					: new URL(input, "http://hlid.local");
		const path = url.pathname.split("/").map(safeSegment).join("/");
		return path || "/";
	} catch {
		return "/unknown";
	}
}
