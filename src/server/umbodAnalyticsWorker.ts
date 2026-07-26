import { createUmbod, type Manifest, type Umbod } from "@umbod/core";
import {
	readUmbodAnalyticsFromEngine,
	readUmbodCallsFromEngine,
} from "./umbodAnalyticsQueries";
import type {
	UmbodAnalyticsWorkerRequest,
	UmbodAnalyticsWorkerResponse,
} from "./umbodAnalyticsWorkerProtocol";

let instance: Umbod | null = null;
let instanceKey: string | null = null;

function errorMessage(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}

async function getUmbod(
	manifest: Manifest,
	databasePath: string,
): Promise<Umbod> {
	const key = `${JSON.stringify(manifest)}\0${databasePath}`;
	if (instance && instanceKey === key) return instance;
	instance?.close();
	instance = createUmbod({
		manifest,
		dbPath: databasePath,
		sessionLogSources: [{ agent: "claude" }, { agent: "codex" }],
	});
	instanceKey = key;
	return instance;
}

async function handleRequest(
	request: UmbodAnalyticsWorkerRequest,
): Promise<void> {
	const response: UmbodAnalyticsWorkerResponse = { id: request.id };
	try {
		const umbod = await getUmbod(request.manifest, request.databasePath);
		response.result =
			request.kind === "snapshot"
				? await readUmbodAnalyticsFromEngine(umbod)
				: await readUmbodCallsFromEngine(
						umbod,
						new URLSearchParams(request.searchParams),
					);
	} catch (error) {
		response.error = errorMessage(error);
	}
	self.postMessage(response);
}

let requestQueue = Promise.resolve();
self.onmessage = (event: MessageEvent<UmbodAnalyticsWorkerRequest>): void => {
	const request = event.data;
	requestQueue = requestQueue.then(
		() => handleRequest(request),
		() => handleRequest(request),
	);
};
