import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { parse } from "smol-toml";
import { defineConfig, type Plugin } from "vite";
import { isAllowedOrigin } from "./src/lib/allowedOrigin";

type ServerConfig = {
	tls_cert_path?: string;
	tls_key_path?: string;
	port?: number;
	local_network_access?: boolean;
};

function loadServerConfig(): ServerConfig {
	const configPath = resolve(process.cwd(), "hlid.config.toml");
	if (!existsSync(configPath)) return {};
	try {
		const parsed = parse(readFileSync(configPath, "utf-8")) as {
			server?: ServerConfig;
		};
		return parsed.server ?? {};
	} catch {
		return {};
	}
}

function loadTls(server: ServerConfig): {
	cert: Buffer;
	key: Buffer;
	wsPort: number;
	hostname: string;
} | null {
	const certPath = server.tls_cert_path;
	const keyPath = server.tls_key_path;
	if (!certPath || !keyPath) return null;
	try {
		const wsPort = (server.port ?? 3000) + 1;
		const cert = readFileSync(resolve(certPath));
		const key = readFileSync(resolve(keyPath));
		// Extract hostname from cert SAN so Vite HMR knows the external host.
		const x509 = new X509Certificate(cert);
		const san = x509.subjectAltName ?? "";
		const dnsSan = san.split(", ").find((s) => s.startsWith("DNS:"));
		const hostname = dnsSan ? dnsSan.slice(4) : "localhost";
		return { cert, key, wsPort, hostname };
	} catch {
		return null;
	}
}

function ipGatePlugin(allowLocalNetwork: boolean): Plugin {
	return {
		name: "hlid-ip-gate",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				// On TLS upgrade requests Bun may surface the address on the
				// inner socket rather than the outer TLS wrapper.
				const sock = req.socket as
					| (typeof req.socket & { socket?: { remoteAddress?: string } })
					| undefined;
				const addr = sock?.remoteAddress ?? sock?.socket?.remoteAddress;
				if (!isAllowedOrigin(addr, allowLocalNetwork)) {
					res.writeHead(403, { "content-type": "text/plain" });
					res.end("Forbidden");
					return;
				}
				next();
			});
		},
	};
}

// TLS only when HLID_TLS=1 — cert is valid for Tailscale host, not localhost.
const serverCfg = loadServerConfig();
const tls = /^1|true$/i.test(process.env.HLID_TLS ?? "")
	? loadTls(serverCfg)
	: null;

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		ipGatePlugin(serverCfg.local_network_access ?? false),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
	server: {
		host: "0.0.0.0",
		allowedHosts: true,
		...(tls
			? {
					https: { cert: tls.cert, key: tls.key, ALPNProtocols: ["http/1.1"] },
					hmr: { protocol: "wss", host: tls.hostname, clientPort: 3000 },
					// Proxy /ws to the plain-HTTP Bun server so WSS works without
					// giving Bun a TLS cert (SSR server functions call localhost HTTP).
					proxy: {
						"/ws": {
							target: `ws://localhost:${tls.wsPort}`,
							ws: true,
						},
					},
				}
			: {}),
	},
});

export default config;
