export type InternalApiHandler = (request: Request) => Promise<Response>;

// The compiled entry bundle and TanStack Start SSR bundle have separate module
// instances but share one global object. Registering the internal API handler
// here lets server functions dispatch directly instead of making a loopback
// HTTP request back into the same Bun process.
const G = globalThis as Record<string, unknown>;
const INTERNAL_API_HANDLER_KEY = "__hlidInternalApiHandler";

export function registerInternalApiHandler(handler: InternalApiHandler): void {
	G[INTERNAL_API_HANDLER_KEY] = handler;
}

export function getInternalApiHandler(): InternalApiHandler | null {
	return (
		(G[INTERNAL_API_HANDLER_KEY] as InternalApiHandler | undefined) ?? null
	);
}

/** @internal */
export function resetInternalApiHandlerForTesting(): void {
	delete G[INTERNAL_API_HANDLER_KEY];
}
