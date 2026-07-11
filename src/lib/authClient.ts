const AUTH_PATH_PREFIX = "/api/auth/";

export function shouldRedirectUnauthorized(
	status: number,
	requestUrl: string,
	currentUrl: string,
): boolean {
	if (status !== 401) return false;
	try {
		const request = new URL(requestUrl, currentUrl);
		const current = new URL(currentUrl);
		return (
			request.origin === current.origin &&
			!request.pathname.startsWith(AUTH_PATH_PREFIX) &&
			current.pathname !== "/login" &&
			current.pathname !== "/login/"
		);
	} catch {
		return false;
	}
}

/** Install before the router starts so unauthorized loader/server-function/API
 * responses become a login navigation instead of TanStack's generic error UI. */
export function installAuthRedirect(): void {
	if (typeof window === "undefined") return;
	const target = window as typeof window & {
		__hlidAuthFetchInstalled?: boolean;
	};
	if (target.__hlidAuthFetchInstalled) return;
	target.__hlidAuthFetchInstalled = true;

	const browser = window as unknown as {
		fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	};
	const originalFetch = browser.fetch.bind(window);
	let redirecting = false;
	browser.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await originalFetch(input, init);
		const requestUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (
			!redirecting &&
			shouldRedirectUnauthorized(response.status, requestUrl, location.href)
		) {
			redirecting = true;
			location.replace("/login");
		}
		return response;
	};
}
