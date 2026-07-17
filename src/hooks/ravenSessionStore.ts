import { useSyncExternalStore } from "react";

const RAVEN_SESSION_KEY = "hlid:raven:last-session";
const RAVEN_AGENT_KEY = "hlid:raven:last-agent";

type RavenLocation = {
	sessionId: string;
	agent?: string;
};

let initialized = false;
let lastLocation: RavenLocation | null = null;
const listeners = new Set<() => void>();

function validSessionId(value: string | null): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 512 ? trimmed : null;
}

function validAgent(value: string | null): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length <= 4096 ? trimmed : undefined;
}

function readStoredLocation(): RavenLocation | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const sessionId = validSessionId(localStorage.getItem(RAVEN_SESSION_KEY));
		if (!sessionId) return null;
		const agent = validAgent(localStorage.getItem(RAVEN_AGENT_KEY));
		return { sessionId, ...(agent ? { agent } : {}) };
	} catch {
		return null;
	}
}

function getLastRavenLocation(): RavenLocation | null {
	if (!initialized && typeof window !== "undefined") {
		initialized = true;
		lastLocation = readStoredLocation();
	}
	return lastLocation;
}

export function rememberRavenSessionId(
	sessionId: string,
	agent?: string,
): void {
	const nextSessionId = validSessionId(sessionId);
	if (!nextSessionId) return;
	const nextAgent = validAgent(agent ?? null);
	initialized = true;
	if (
		lastLocation?.sessionId === nextSessionId &&
		lastLocation.agent === nextAgent
	)
		return;
	lastLocation = {
		sessionId: nextSessionId,
		...(nextAgent ? { agent: nextAgent } : {}),
	};
	try {
		localStorage.setItem(RAVEN_SESSION_KEY, nextSessionId);
		if (nextAgent) localStorage.setItem(RAVEN_AGENT_KEY, nextAgent);
		else localStorage.removeItem(RAVEN_AGENT_KEY);
	} catch {}
	for (const listener of listeners) listener();
}

export function rememberedRavenAgent(sessionId: string): string | undefined {
	const validId = validSessionId(sessionId);
	if (!validId) return undefined;
	const stored = readStoredLocation();
	return stored?.sessionId === validId ? stored.agent : undefined;
}

function subscribeLastRavenSession(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useLastRavenSession(): RavenLocation | null {
	return useSyncExternalStore(
		subscribeLastRavenSession,
		getLastRavenLocation,
		() => null,
	);
}
