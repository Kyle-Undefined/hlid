// The compiled entry bundle and TanStack Start bundle have separate module
// instances but share one global object. Keep the live policy there so every
// writer in the packaged process observes the same value.
const EVENT_LOG_POLICY_KEY = "__hlidEventLogPersistenceEnabled";
const policyGlobal = globalThis as Record<string, unknown>;

/**
 * Apply the durable Event Log policy to this Hlid process.
 *
 * The default stays enabled so callers that run before configuration is loaded
 * keep today's diagnostic behavior. The server applies the configured value
 * during startup and every successful config write applies it again live.
 */
export function setEventLogPersistenceEnabled(enabled: boolean): void {
	policyGlobal[EVENT_LOG_POLICY_KEY] = enabled;
}

export function isEventLogPersistenceEnabled(): boolean {
	return policyGlobal[EVENT_LOG_POLICY_KEY] !== false;
}
