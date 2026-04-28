import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { parse } from "smol-toml";
import { defineConfig, type Plugin } from "vite";

function loadTls(): {
	cert: Buffer;
	key: Buffer;
	wsPort: number;
	hostname: string;
} | null {
	const configPath = resolve(process.cwd(), "hlid.config.toml");
	if (!existsSync(configPath)) return null;
	try {
		const parsed = parse(readFileSync(configPath, "utf-8")) as {
			server?: { tls_cert_path?: string; tls_key_path?: string; port?: number };
		};
		const certPath = parsed.server?.tls_cert_path;
		const keyPath = parsed.server?.tls_key_path;
		if (!certPath || !keyPath) return null;
		const wsPort = (parsed.server?.port ?? 3000) + 1;
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

function ipGatePlugin(): Plugin {
	function isAllowed(raw: string | undefined): boolean {
		if (!raw) return false;
		const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
		if (ip === "127.0.0.1" || ip === "::1") return true;
		// Tailscale IPv6 (fd7a:115c:a1e0::/48)
		if (ip.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
		const parts = ip.split(".");
		if (parts.length !== 4) return false;
		const a = parseInt(parts[0], 10);
		const b = parseInt(parts[1], 10);
		return a === 100 && b >= 64 && b <= 127;
	}
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
				if (!isAllowed(addr)) {
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
const tls = process.env.HLID_TLS ? loadTls() : null;

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [ipGatePlugin(), tailwindcss(), tanstackStart(), viteReact()],
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
