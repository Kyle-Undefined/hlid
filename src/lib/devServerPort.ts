const MAX_UI_PORT = 65_534;

/**
 * Apply the explicit development-only UI port override used by Project Preview.
 * The internal API/WebSocket server always owns the following port.
 */
export function resolveDevServerPort(
	configuredPort: number,
	override = process.env.HLID_DEV_PORT,
): number {
	if (override === undefined || override.trim() === "") return configuredPort;
	const normalized = override.trim();
	if (!/^\d+$/.test(normalized)) {
		throw new Error(`HLID_DEV_PORT must be an integer, received "${override}"`);
	}
	const port = Number(normalized);
	if (!Number.isSafeInteger(port) || port < 1 || port > MAX_UI_PORT) {
		throw new Error(
			`HLID_DEV_PORT must be between 1 and ${MAX_UI_PORT}, received "${override}"`,
		);
	}
	return port;
}
