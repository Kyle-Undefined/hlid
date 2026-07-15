const BUILD_REQUEST = "hlid:get-build";
const BUILD_RESPONSE = "hlid:build";

type BuildResponse = { type?: string; build?: string };
type ServiceWorkerMessenger = {
	postMessage(message: unknown, transfer: Transferable[]): void;
};

export async function serviceWorkerBuild(
	worker: ServiceWorkerMessenger,
	timeoutMs = 1_000,
): Promise<string | null> {
	const channel = new MessageChannel();
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (build: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			channel.port1.close();
			resolve(build);
		};
		const timeout = setTimeout(() => finish(null), timeoutMs);
		channel.port1.onmessage = (event: MessageEvent<BuildResponse>) => {
			const response = event.data;
			finish(
				response?.type === BUILD_RESPONSE && typeof response.build === "string"
					? response.build
					: null,
			);
		};
		try {
			worker.postMessage({ type: BUILD_REQUEST }, [channel.port2]);
		} catch {
			finish(null);
		}
	});
}

/** Reload only when the active worker proves this page is an older build. */
export function shouldReloadForServiceWorkerBuild(
	pageBuild: string,
	workerBuild: string | null,
): boolean {
	// A worker without the build handshake predates this safeguard. Preserve the
	// old conservative behavior for that one-time upgrade.
	return workerBuild === null || workerBuild !== pageBuild;
}
