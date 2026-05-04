import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde, pathStartsWith } from "#/lib/paths";
import { loadConfig } from "#/server/config";

function safePath(reqPath: string, allowedRoots: string[]): string | null {
	try {
		const real = realpathSync(resolve(expandTilde(reqPath)));
		if (allowedRoots.some((r) => pathStartsWith(r, real))) return real;
		return null;
	} catch {
		return null;
	}
}

function unrestrictedPath(reqPath: string): string | null {
	const r = resolve(expandTilde(reqPath));
	try {
		return realpathSync(r);
	} catch {
		// UNC paths like \\wsl.localhost\ are valid on Windows but realpathSync may reject them.
		if (r.startsWith("\\\\")) return r;
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
				const url = new URL(request.url);

				if (url.searchParams.get("wsl") === "1") {
					try {
						const raw = execFileSync(
							"wsl",
							["-e", "sh", "-c", "wslpath -w ~"],
							{ encoding: "utf-8", timeout: 5000, windowsHide: true },
						).trim();
						if (!raw.startsWith("\\\\")) throw new Error("unexpected");
						return Response.json({ wslHome: raw });
					} catch {
						return Response.json(
							{ error: "WSL not available" },
							{ status: 404 },
						);
					}
				}

				const externalRequested = url.searchParams.get("external") === "1";
				const externalAllowed =
					externalRequested && config.server.allow_external_agents;

				let defaultRoot: string;
				let safed: string | null;
				if (externalAllowed) {
					try {
						defaultRoot = realpathSync(homedir());
					} catch {
						return Response.json(
							{ error: "Home directory not accessible" },
							{ status: 500 },
						);
					}
					const raw = url.searchParams.get("path") ?? defaultRoot;
					safed = unrestrictedPath(raw);
				} else {
					// First-run / no vault: allow browsing under the user's home directory so
					// the wizard's FolderBrowser can pick a vault before one is configured.
					let allowedRoots: string[];
					if (!vaultPath) {
						try {
							defaultRoot = realpathSync(homedir());
						} catch {
							return Response.json(
								{ error: "Home directory not accessible" },
								{ status: 500 },
							);
						}
						allowedRoots = [defaultRoot];
					} else {
						try {
							defaultRoot = realpathSync(expandTilde(vaultPath));
							statSync(defaultRoot); // must exist
						} catch {
							return Response.json(
								{ error: "Vault path not accessible" },
								{ status: 400 },
							);
						}
						allowedRoots = [defaultRoot];
					}
					const raw = url.searchParams.get("path") ?? defaultRoot;
					safed = safePath(raw, allowedRoots);
				}

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
