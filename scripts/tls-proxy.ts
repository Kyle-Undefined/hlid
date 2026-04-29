import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { isAllowedOrigin } from "../src/lib/allowedOrigin.ts";

const configPath = resolve(process.cwd(), "hlid.config.toml");

if (!existsSync(configPath)) {
	console.log("[tls] No hlid.config.toml — TLS proxy not started.");
	process.exit(0);
}

const raw = parse(readFileSync(configPath, "utf-8")) as {
	server?: {
		tls_cert_path?: string;
		tls_key_path?: string;
		port?: number;
		tls_proxy_port?: number;
		local_network_access?: boolean;
	};
};

const certPath = raw.server?.tls_cert_path;
const keyPath = raw.server?.tls_key_path;

if (!certPath || !keyPath) {
	console.log("[tls] No cert/key configured — TLS proxy not started.");
	process.exit(0);
}

const vitePort = raw.server?.port ?? 3000;
const bunPort = vitePort + 1;
const tlsPort = raw.server?.tls_proxy_port ?? 3443;
const localNetworkAccess = raw.server?.local_network_access ?? false;

const certBuf = readFileSync(resolve(certPath));
const x509 = new X509Certificate(certBuf);
const san = x509.subjectAltName ?? "";
const dnsSan = san.split(", ").find((s) => s.startsWith("DNS:"));
const tlsHostname = dnsSan ? dnsSan.slice(4) : "localhost";

type WsData = { wsTarget: string; back: WebSocket | null; queue: (string | ArrayBuffer | Uint8Array)[] };

const SKIP_REQ_HEADERS = new Set(["host", "connection", "keep-alive"]);
const SKIP_RES_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

Bun.serve<WsData>({
	port: tlsPort,
	hostname: "0.0.0.0",
	tls: {
		cert: Bun.file(resolve(certPath)),
		key: Bun.file(resolve(keyPath)),
	},
	websocket: {
		open(ws) {
			ws.data.queue = [];
			const back = new WebSocket(ws.data.wsTarget);
			ws.data.back = back;
			back.onopen = () => {
				for (const msg of ws.data.queue) ws.data.back!.send(msg);
				ws.data.queue = [];
			};
			back.onmessage = (ev) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(ev.data);
			};
			back.onclose = () => ws.close();
			back.onerror = () => ws.close();
		},
		message(ws, data) {
			if (ws.data.back?.readyState === WebSocket.OPEN) {
				ws.data.back.send(data);
			} else {
				ws.data.queue.push(data);
			}
		},
		close(ws) {
			ws.data.back?.close();
		},
	},
	async fetch(req, server) {
		const addr = server.requestIP(req)?.address;
		if (!isAllowedOrigin(addr, localNetworkAccess)) {
			return new Response("Forbidden", { status: 403 });
		}

		const url = new URL(req.url);

		if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, {
					data: { wsTarget: `ws://localhost:${bunPort}/ws${url.search}`, back: null, queue: [] },
				});
				if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 });
				return;
			}
			return new Response("Bad Request", { status: 400 });
		}

		const fwdHeaders = new Headers();
		for (const [k, v] of req.headers.entries()) {
			if (!SKIP_REQ_HEADERS.has(k.toLowerCase())) fwdHeaders.set(k, v);
		}

		let upstream: Response;
		try {
			upstream = await fetch(
				`http://localhost:${vitePort}${url.pathname}${url.search}`,
				{
					method: req.method,
					headers: fwdHeaders,
					body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
				},
			);
		} catch {
			return new Response("Bad Gateway", { status: 502 });
		}

		const resHeaders = new Headers();
		for (const [k, v] of upstream.headers.entries()) {
			if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders.set(k, v);
		}

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: resHeaders,
		});
	},
});

console.log(`[tls] https://${tlsHostname}:${tlsPort}`);
