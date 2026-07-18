import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createFileRoute } from "@tanstack/react-router";
import { forbiddenResponse } from "#/lib/originGate";
import { expandTilde, pathStartsWith } from "#/lib/paths";
import { loadConfig } from "#/server/config";

const execFileAsync = promisify(execFile);

async function safePath(
	reqPath: string,
	allowedRoots: string[],
): Promise<string | null> {
	try {
		const real = await realpath(resolve(expandTilde(reqPath)));
		if (allowedRoots.some((r) => pathStartsWith(r, real))) return real;
		return null;
	} catch {
		return null;
	}
}

async function unrestrictedPath(reqPath: string): Promise<string | null> {
	const r = resolve(expandTilde(reqPath));
	try {
		return await realpath(r);
	} catch {
		// UNC paths like \\wsl.localhost\ are valid on Windows but realpathSync may reject them.
		if (r.startsWith("\\\\")) return r;
		return null;
	}
}

export async function handleBrowseRequest(request: Request): Promise<Response> {
	const forbidden = forbiddenResponse(request);
	if (forbidden) return forbidden;

	const config = loadConfig();
	const vaultPath = config.vault?.path;
	const url = new URL(request.url);

	if (url.searchParams.get("wsl") === "1") {
		try {
			const { stdout } = await execFileAsync(
				"wsl",
				["-e", "sh", "-c", "wslpath -w ~"],
				{
					encoding: "utf-8",
					timeout: 5000,
					windowsHide: true,
				},
			);
			const raw = stdout.trim();
			if (!raw.startsWith("\\\\")) throw new Error("unexpected");
			return Response.json({ wslHome: raw });
		} catch {
			return Response.json({ error: "WSL not available" }, { status: 404 });
		}
	}

	const externalRequested = url.searchParams.get("external") === "1";
	const externalAllowed =
		externalRequested && config.server.allow_external_agents;

	let defaultRoot: string;
	let safed: string | null;
	if (externalAllowed) {
		try {
			defaultRoot = await realpath(homedir());
		} catch {
			return Response.json(
				{ error: "Home directory not accessible" },
				{ status: 500 },
			);
		}
		const raw = url.searchParams.get("path") ?? defaultRoot;
		safed = await unrestrictedPath(raw);
	} else {
		// First-run / no vault: allow browsing under the user's home directory so
		// the wizard's FolderBrowser can pick a vault before one is configured.
		let allowedRoots: string[];
		if (!vaultPath) {
			try {
				defaultRoot = await realpath(homedir());
			} catch {
				return Response.json(
					{ error: "Home directory not accessible" },
					{ status: 500 },
				);
			}
			allowedRoots = [defaultRoot];
		} else {
			try {
				defaultRoot = await realpath(expandTilde(vaultPath));
				await stat(defaultRoot); // must exist
			} catch {
				return Response.json(
					{ error: "Vault path not accessible" },
					{ status: 400 },
				);
			}
			allowedRoots = [defaultRoot];
		}
		const raw = url.searchParams.get("path") ?? defaultRoot;
		safed = await safePath(raw, allowedRoots);
	}

	if (!safed) {
		return Response.json({ error: "Access denied" }, { status: 403 });
	}

	try {
		const entries = await readdir(safed, { withFileTypes: true });
		return Response.json({
			path: safed,
			entries: entries
				.filter((e) => !e.name.startsWith("."))
				.map((e) => ({
					name: e.name,
					isDirectory: e.isDirectory(),
				}))
				.sort((a, b) => {
					if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
					return a.name.localeCompare(b.name);
				}),
		});
	} catch {
		return Response.json({ error: "Cannot read directory" }, { status: 400 });
	}
}

export const Route = createFileRoute("/api/browse")({
	server: {
		handlers: {
			GET: ({ request }) => handleBrowseRequest(request),
		},
	},
});
