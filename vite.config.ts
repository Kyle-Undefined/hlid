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

function bindHost(allowLocalNetwork: boolean): string {
	return allowLocalNetwork ? "0.0.0.0" : "127.0.0.1";
}

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

function chunkBudgetPlugin(): Plugin {
	const generalLimit = 500 * 1024;
	const lazyMermaidParserLimit = 700 * 1024;
	return {
		name: "hlid-chunk-budget",
		apply: "build",
		generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") continue;
				const bytes = Buffer.byteLength(output.code);
				if (bytes <= generalLimit) continue;
				const isLazyMermaidParser =
					output.name.startsWith("mermaid-vendor") &&
					bytes <= lazyMermaidParserLimit;
				if (!isLazyMermaidParser) {
					this.error(
						`${output.fileName} is ${Math.ceil(bytes / 1024)} KiB; client chunks must stay at or below 500 KiB`,
					);
				}
			}
		},
	};
}

// TLS only when HLID_TLS=1. Cert is valid for Tailscale host, not localhost.
const serverCfg = loadServerConfig();
const tls = /^1|true$/i.test(process.env.HLID_TLS ?? "")
	? loadTls(serverCfg)
	: null;

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	build: {
		// One feature-gated Langium parser chunk from Mermaid cannot be split at
		// module boundaries. The custom budget plugin below caps that exception at
		// 700 KiB while enforcing 500 KiB for every other client chunk.
		chunkSizeWarningLimit: 700,
		rolldownOptions: {
			output: {
				strictExecutionOrder: true,
				// Keep large third-party graphs independently cacheable and below the
				// mobile parse-cost budget without coupling application modules by hand.
				codeSplitting: {
					groups: [
						{
							name: "mermaid-vendor",
							test: /node_modules[\\/](?:mermaid|@mermaid-js)/,
							maxSize: 300 * 1024,
							includeDependenciesRecursively: false,
							priority: 10,
						},
						{
							name: "large-vendor",
							test: /node_modules/,
							minSize: 100 * 1024,
							maxSize: 350 * 1024,
							entriesAware: true,
						},
					],
				},
			},
		},
	},
	plugins: [
		chunkBudgetPlugin(),
		ipGatePlugin(serverCfg.local_network_access ?? false),
		tailwindcss(),
		tanstackStart({
			// The unauthenticated login route is the only safe static SPA shell.
			spa: {
				enabled: true,
				maskPath: "/login",
				prerender: { headers: { "x-hlid-login-shell": "build" } },
			},
			router: { routeFileIgnorePattern: "\\.test\\.(ts|tsx)$" },
		}),
		viteReact(),
	],
	server: {
		host: bindHost(serverCfg.local_network_access ?? false),
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
	// xterm publishes CommonJS runtime files behind ESM-style type declarations.
	// Bundle them into SSR so Node prerender does not attempt unsupported named
	// imports from an externalized CommonJS module.
	ssr: { noExternal: ["@xterm/xterm", "@xterm/addon-fit"] },
});

export default config;
