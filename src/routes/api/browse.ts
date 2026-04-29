import { readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { loadConfig } from "#/server/config";

function safePath(reqPath: string, allowedRoots: string[]): string | null {
	try {
		const real = realpathSync(resolve(reqPath));
		if (allowedRoots.some((r) => real === r || real.startsWith(r + sep)))
			return real;
		return null;
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/api/browse")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const forbidden = forbiddenResponse(request);
				if (forbidden) return forbidden;

				const config = loadConfig();
				const vaultPath = config.vault?.path;
				if (!vaultPath) {
					return Response.json(
						{ error: "Vault not configured" },
						{ status: 400 },
					);
				}

				// allowedRoots: vault path only for now — extend this list to add more dirs later
				let vaultReal: string;
				try {
					vaultReal = realpathSync(vaultPath);
					statSync(vaultReal); // must exist
				} catch {
					return Response.json(
						{ error: "Vault path not accessible" },
						{ status: 400 },
					);
				}
				const allowedRoots = [vaultReal];

				const url = new URL(request.url);
				const raw = url.searchParams.get("path") ?? vaultReal;
				const safed = safePath(raw, allowedRoots);

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
