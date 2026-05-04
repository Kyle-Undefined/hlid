import { createFileRoute } from "@tanstack/react-router";
import {
	getAutostart,
	getInstallPaths,
	installAutostart,
	openInstallDir,
	shutdown,
	uninstallAutostart,
} from "#/lib/lifecycle";
import { forbiddenResponse } from "#/lib/originGate";

const ACTIONS = [
	"install",
	"uninstall",
	"shutdown",
	"open_install_dir",
] as const;
type Action = (typeof ACTIONS)[number];

function isAction(v: unknown): v is Action {
	return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

export const Route = createFileRoute("/api/lifecycle")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				const autostart = await getAutostart();
				if (!autostart.ok) return Response.json(autostart);
				const install = getInstallPaths();
				const data =
					typeof autostart.data === "object" && autostart.data !== null
						? { ...(autostart.data as object), install }
						: { install };
				return Response.json({ ok: true, data });
			},
			POST: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;
				let body: { action?: unknown };
				try {
					body = (await request.json()) as { action?: unknown };
				} catch {
					return Response.json(
						{ ok: false, error: "Invalid JSON" },
						{ status: 400 },
					);
				}
				if (!isAction(body.action)) {
					return Response.json(
						{
							ok: false,
							error: `action must be one of: ${ACTIONS.join(", ")}`,
						},
						{ status: 400 },
					);
				}
				switch (body.action) {
					case "install":
						return Response.json(await installAutostart());
					case "uninstall":
						return Response.json(await uninstallAutostart());
					case "shutdown":
						return Response.json(shutdown());
					case "open_install_dir":
						return Response.json(await openInstallDir());
				}
			},
		},
	},
});
