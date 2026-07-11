import { createFileRoute } from "@tanstack/react-router";
import { parseJsonAction } from "#/lib/actionRequest";
import {
	getAutostart,
	getInstallPaths,
	installAutostart,
	openInstallDir,
	restart,
	shutdown,
	uninstallAutostart,
} from "#/lib/lifecycle";
import { forbiddenResponse } from "#/lib/originGate";

const ACTIONS = [
	"install",
	"uninstall",
	"shutdown",
	"restart",
	"open_install_dir",
] as const;
export async function handleGetLifecycle(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	try {
		const autostart = await getAutostart();
		if (!autostart.ok) return Response.json(autostart);
		const install = getInstallPaths();
		const data =
			typeof autostart.data === "object" && autostart.data !== null
				? { ...(autostart.data as object), install }
				: { install };
		return Response.json({ ok: true, data });
	} catch {
		return Response.json(
			{ ok: false, error: "Failed to read lifecycle state" },
			{ status: 500 },
		);
	}
}

export async function handlePostLifecycle(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;
	const parsed = await parseJsonAction(request, ACTIONS);
	if (parsed instanceof Response) return parsed;
	try {
		switch (parsed.action) {
			case "install":
				return Response.json(await installAutostart());
			case "uninstall":
				return Response.json(await uninstallAutostart());
			case "shutdown":
				return Response.json(shutdown());
			case "restart":
				return Response.json(restart());
			case "open_install_dir":
				return Response.json(await openInstallDir());
		}
	} catch {
		return Response.json(
			{ ok: false, error: "Lifecycle action failed" },
			{ status: 500 },
		);
	}
}

export const Route = createFileRoute("/api/lifecycle")({
	server: {
		handlers: {
			GET: ({ request }) => handleGetLifecycle(request),
			POST: ({ request }) => handlePostLifecycle(request),
		},
	},
});
