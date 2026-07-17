const EXISTING_INSTANCE_PROBE_TIMEOUT_MS = 800;

/** Return the local UI URL when another Hlið instance is already serving it. */
export async function probeExistingInstance(
	port: number,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const url = `http://127.0.0.1:${port}/`;
	try {
		const response = await fetchImpl(url, {
			signal: AbortSignal.timeout(EXISTING_INSTANCE_PROBE_TIMEOUT_MS),
		});
		return response.ok ? url : null;
	} catch {
		return null;
	}
}
