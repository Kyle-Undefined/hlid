import { createServerFn } from "@tanstack/react-start";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { CliProxyStatus } from "#/server/cliproxyManager";

const FALLBACK: CliProxyStatus = {
	state: "error",
	managed: false,
	authenticated: false,
	oauth: "idle",
	error: "CLIProxy integration unavailable",
};

export const getCliProxyInfoFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<CliProxyStatus>("/cliproxy", FALLBACK),
);

export const refreshCliProxyInfoFn = createServerFn({ method: "GET" }).handler(
	() => dbJson<CliProxyStatus>("/cliproxy?refresh=1", FALLBACK),
);

async function action(path: string, method = "POST"): Promise<CliProxyStatus> {
	const response = await requireDbOk(
		await dbFetch(path, { method }),
		`CLIProxy ${path.split("/").pop() || "action"}`,
	);
	return (await response.json()) as CliProxyStatus;
}

export const installCliProxyFn = createServerFn({ method: "POST" }).handler(
	() => action("/cliproxy/install"),
);

export const startCliProxyFn = createServerFn({ method: "POST" }).handler(() =>
	action("/cliproxy/start"),
);

export const stopCliProxyFn = createServerFn({ method: "POST" }).handler(() =>
	action("/cliproxy/stop"),
);

export const connectCliProxyCodexFn = createServerFn({
	method: "POST",
}).handler(() => action("/cliproxy/oauth"));

export const removeCliProxyFn = createServerFn({ method: "POST" }).handler(() =>
	action("/cliproxy", "DELETE"),
);
