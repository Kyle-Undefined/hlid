import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import type {
	OllamaIntegrationInfo,
	OllamaPullState,
} from "#/server/ollamaIntegration";

const modelName = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.refine(
		(value) => !/\s/.test(value),
		"Model names cannot contain whitespace",
	);

const OLLAMA_INSPECTION_ERROR =
	"Could not inspect Windows Ollama. Hlid could not read the integration status. Try again.";
const OLLAMA_SETUP_INSPECTION_ERROR =
	"Could not inspect Ollama Windows setup. Hlid will keep the last known setup state.";

export type OllamaWindowsSetupInfo = Pick<
	OllamaIntegrationInfo,
	"setup" | "status"
>;

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasOllamaSetupShape(
	value: unknown,
): value is OllamaIntegrationInfo["setup"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const setup = value as Record<string, unknown>;
	switch (setup.phase) {
		case "idle":
			return true;
		case "resolving":
			return finiteNumber(setup.startedAt);
		case "downloading":
		case "verifying":
			return (
				finiteNumber(setup.startedAt) &&
				typeof setup.version === "string" &&
				finiteNumber(setup.received) &&
				finiteNumber(setup.total)
			);
		case "ready":
			return (
				finiteNumber(setup.startedAt) &&
				finiteNumber(setup.completedAt) &&
				typeof setup.version === "string" &&
				finiteNumber(setup.bytes)
			);
		case "verification_failed":
			return (
				finiteNumber(setup.startedAt) &&
				finiteNumber(setup.completedAt) &&
				typeof setup.version === "string" &&
				finiteNumber(setup.bytes) &&
				typeof setup.reason === "string"
			);
		case "launched":
			return (
				finiteNumber(setup.startedAt) &&
				finiteNumber(setup.launchedAt) &&
				typeof setup.version === "string" &&
				finiteNumber(setup.bytes)
			);
		case "complete":
			return (
				typeof setup.version === "string" && finiteNumber(setup.detectedAt)
			);
		case "canceled":
			return finiteNumber(setup.startedAt) && finiteNumber(setup.completedAt);
		case "failed":
			return (
				finiteNumber(setup.startedAt) &&
				finiteNumber(setup.completedAt) &&
				typeof setup.reason === "string"
			);
		default:
			return false;
	}
}

export function isOllamaIntegrationInfo(
	value: unknown,
): value is OllamaIntegrationInfo {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	const status = candidate.status;
	const setup = candidate.setup;
	const firewall = candidate.firewall;
	const relay = candidate.relay;
	return (
		typeof candidate.supported === "boolean" &&
		candidate.host === "windows" &&
		typeof status === "object" &&
		status !== null &&
		typeof (status as Record<string, unknown>).available === "boolean" &&
		hasOllamaSetupShape(setup) &&
		Array.isArray(candidate.models) &&
		Array.isArray(candidate.loadedModels) &&
		Array.isArray(candidate.preparedModels) &&
		Array.isArray(candidate.selectedModels) &&
		typeof candidate.pull === "object" &&
		candidate.pull !== null &&
		typeof firewall === "object" &&
		firewall !== null &&
		Array.isArray(candidate.wsl) &&
		typeof relay === "object" &&
		relay !== null &&
		Array.isArray((relay as Record<string, unknown>).listeners)
	);
}

function hasOllamaSetupInfoShape(
	value: unknown,
): value is OllamaWindowsSetupInfo {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	const status = candidate.status;
	return (
		typeof status === "object" &&
		status !== null &&
		typeof (status as Record<string, unknown>).available === "boolean" &&
		hasOllamaSetupShape(candidate.setup)
	);
}

/** A live status read must never turn a transport failure into an unsupported host. */
export async function inspectOllamaInfo(): Promise<OllamaIntegrationInfo> {
	try {
		const response = await requireDbOk(
			await dbFetch("/ollama"),
			"inspect Windows Ollama",
		);
		const payload: unknown = await response.json();
		if (!isOllamaIntegrationInfo(payload)) {
			throw new Error("Ollama status response was malformed");
		}
		return payload;
	} catch (cause) {
		throw new Error(OLLAMA_INSPECTION_ERROR, { cause });
	}
}

export const getOllamaInfoFn = createServerFn({ method: "GET" }).handler(() =>
	inspectOllamaInfo(),
);

/** Poll setup without repeating the full model, firewall, and WSL inventory. */
export async function inspectOllamaWindowsSetupInfo(): Promise<OllamaWindowsSetupInfo> {
	try {
		const response = await requireDbOk(
			await dbFetch("/ollama/setup"),
			"inspect Ollama Windows setup",
		);
		const payload: unknown = await response.json();
		if (!hasOllamaSetupInfoShape(payload)) {
			throw new Error("Ollama setup response was malformed");
		}
		return payload;
	} catch (cause) {
		throw new Error(OLLAMA_SETUP_INSPECTION_ERROR, { cause });
	}
}

export const getOllamaWindowsSetupInfoFn = createServerFn({
	method: "GET",
}).handler(inspectOllamaWindowsSetupInfo);

async function ollamaWindowsSetupAction(
	path: "/ollama/setup/download" | "/ollama/setup/launch",
	method: "POST" | "DELETE",
	operation: string,
): Promise<OllamaIntegrationInfo["setup"]> {
	const response = await requireDbOk(
		await dbFetch(path, { method }),
		operation,
	);
	const payload: unknown = await response.json();
	if (!hasOllamaSetupShape(payload)) {
		throw new Error(`${operation} returned a malformed setup state`);
	}
	return payload;
}

/** Start a download, or retry verification of the retained SHA-verified installer. */
export async function startOllamaWindowsSetupDownload(): Promise<
	OllamaIntegrationInfo["setup"]
> {
	return ollamaWindowsSetupAction(
		"/ollama/setup/download",
		"POST",
		"start the Ollama Windows installer download",
	);
}

/** Cancel only an active installer resolution or download. */
export async function cancelOllamaWindowsSetupDownload(): Promise<
	OllamaIntegrationInfo["setup"]
> {
	return ollamaWindowsSetupAction(
		"/ollama/setup/download",
		"DELETE",
		"cancel the Ollama Windows installer download",
	);
}

/** Launch a downloaded and verified vendor installer after explicit user action. */
export async function launchOllamaWindowsSetup(): Promise<
	OllamaIntegrationInfo["setup"]
> {
	return ollamaWindowsSetupAction(
		"/ollama/setup/launch",
		"POST",
		"launch Ollama Setup on Windows",
	);
}

export const startOllamaWindowsSetupDownloadFn = createServerFn({
	method: "POST",
}).handler(startOllamaWindowsSetupDownload);

export const cancelOllamaWindowsSetupDownloadFn = createServerFn({
	method: "POST",
}).handler(cancelOllamaWindowsSetupDownload);

export const launchOllamaWindowsSetupFn = createServerFn({
	method: "POST",
}).handler(launchOllamaWindowsSetup);

async function modelAction(path: string, model: string): Promise<void> {
	await requireDbOk(
		await dbFetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model }),
		}),
		`Ollama ${path.split("/").pop() || "action"}`,
	);
}

export const pullOllamaModelFn = createServerFn({ method: "POST" })
	.validator((raw: string) => modelName.parse(raw))
	.handler(async ({ data }) => {
		const response = await requireDbOk(
			await dbFetch("/ollama/pull", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: data }),
			}),
			"start Ollama download",
		);
		return (await response.json()) as OllamaPullState;
	});

export const cancelOllamaPullFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const response = await requireDbOk(
			await dbFetch("/ollama/pull/cancel", { method: "POST" }),
			"cancel Ollama download request",
		);
		return (await response.json()) as OllamaPullState;
	},
);

export const installOllamaWslFirewallFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const response = await requireDbOk(
		await dbFetch("/ollama/firewall", { method: "POST" }),
		"install Ollama WSL firewall rule",
	);
	return (await response.json()) as OllamaIntegrationInfo["firewall"];
});

export const removeOllamaWslFirewallFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const response = await requireDbOk(
		await dbFetch("/ollama/firewall", { method: "DELETE" }),
		"remove Ollama WSL firewall rule",
	);
	return (await response.json()) as OllamaIntegrationInfo["firewall"];
});

export const loadOllamaModelFn = createServerFn({ method: "POST" })
	.validator((raw: string) => modelName.parse(raw))
	.handler(async ({ data }) => {
		await modelAction("/ollama/load", data);
		return { ok: true };
	});

export const unloadOllamaModelFn = createServerFn({ method: "POST" })
	.validator((raw: string) => modelName.parse(raw))
	.handler(async ({ data }) => {
		await modelAction("/ollama/unload", data);
		return { ok: true };
	});

export const deleteOllamaModelFn = createServerFn({ method: "POST" })
	.validator((raw: string) => modelName.parse(raw))
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/ollama/model?model=${encodeURIComponent(data)}`, {
				method: "DELETE",
			}),
			"delete Ollama model",
		);
		return { ok: true };
	});
