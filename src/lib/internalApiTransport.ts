import { resolveDevServerPort } from "./devServerPort";

export type InternalApiHandler = (request: Request) => Promise<Response>;

// The compiled entry bundle and TanStack Start SSR bundle have separate module
// instances but share one global object. Registering the internal API handler
// here lets server functions dispatch directly instead of making a loopback
// HTTP request back into the same Bun process.
const G = globalThis as Record<string, unknown>;
const INTERNAL_API_HANDLER_KEY = "__hlidInternalApiHandler";
const INTERNAL_API_BASE_KEY = "__hlidInternalApiBase";

export function registerInternalApiBase(base: string): void {
	G[INTERNAL_API_BASE_KEY] = base.replace(/\/+$/, "");
}

export function getInternalApiBase(): string | null {
	return (G[INTERNAL_API_BASE_KEY] as string | undefined) ?? null;
}

/**
 * Resolve the separate Bun API process used by Vite SSR in Project Preview.
 * Browser code must keep using same-origin routes, so the override only applies
 * while rendering on the server.
 */
export function getSsrDevInternalApiBase(
	isSsr: boolean,
	override = isSsr ? process.env.HLID_DEV_PORT : undefined,
): string | null {
	if (!isSsr || override === undefined || override.trim() === "") return null;
	const uiPort = resolveDevServerPort(3000, override);
	return `http://127.0.0.1:${uiPort + 1}`;
}

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

/** @internal */
export function resetInternalApiBaseForTesting(): void {
	delete G[INTERNAL_API_BASE_KEY];
}
