import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";

const HOME = homedir();

function safePath(reqPath: string): string | null {
	try {
		const real = realpathSync(resolve(reqPath));
		if (!real.startsWith(HOME + sep) && real !== HOME) return null;
		return real;
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/browse")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = await forbiddenResponse();
				if (forbidden) return forbidden;
				const url = new URL(request.url);
				const raw = url.searchParams.get("path") ?? HOME;
				const safed = safePath(raw === "~" ? HOME : raw);

				if (!safed) {
					return Response.json({ error: "Access denied" }, { status: 403 });
				}

				try {
					const entries = readdirSync(safed, { withFileTypes: true });
					return Response.json({
						path: safed,
						entries: entries
							.filter((e) => !e.name.startsWith("."))
							.map((e) => ({
								name: e.name,
								isDirectory: e.isDirectory(),
							}))
							.sort((a, b) => {
								if (a.isDirectory !== b.isDirectory)
									return a.isDirectory ? -1 : 1;
								return a.name.localeCompare(b.name);
							}),
					});
				} catch {
					return Response.json(
						{ error: "Cannot read directory" },
						{ status: 400 },
					);
				}
			},
		},
	},
});
