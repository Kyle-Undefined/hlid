import { isDocumentNavigationRequest } from "../lib/uiRequestSecurity";

let ready = false;

const STARTUP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f0f12">
<title>Starting Hlid</title>
<style>
html,body{height:100%;margin:0;background:#0f0f12;color:#d8c9a7;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
body{display:grid;place-items:center;padding:24px;box-sizing:border-box}
main{width:min(320px,100%);text-align:center}
.mark{width:48px;height:48px;margin:0 auto 20px;border:1px solid #a98248;display:grid;place-items:center;color:#d3a55d;font-size:20px;animation:pulse 1.4s ease-in-out infinite}
h1{margin:0;color:#d3a55d;font-size:14px;letter-spacing:.28em}
p{margin:10px 0 0;color:#8d8370;font-size:10px;letter-spacing:.16em;text-transform:uppercase}
.line{height:1px;margin-top:22px;background:linear-gradient(90deg,transparent,#a98248,transparent);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media(prefers-reduced-motion:reduce){.mark,.line{animation:none;opacity:1}}
</style>
</head>
<body>
<main role="status" aria-live="polite">
<div class="mark" aria-hidden="true">H</div>
<h1>HLIÐ</h1>
<p>Starting system</p>
<div class="line"></div>
</main>
<script>
(function check(){fetch('/api/health',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(v){if(v&&v.service==='hlid'&&v.status==='ok'){location.reload();return}setTimeout(check,250)}).catch(function(){setTimeout(check,250)})})();
</script>
</body>
</html>`;

export function markUiServerReady(): void {
	ready = true;
}

/** Hold document navigation on a standalone splash until the API is ready. */
export function uiStartupGateResponse(request: Request): Response | null {
	if (ready) return null;
	const pathname = new URL(request.url).pathname;
	if (pathname === "/api/health") {
		return Response.json(
			{ service: "hlid", status: "starting" },
			{
				status: 503,
				headers: { "cache-control": "no-store", "retry-after": "1" },
			},
		);
	}
	if (!isDocumentNavigationRequest(request)) return null;
	return new Response(STARTUP_HTML, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** @internal */
export function resetUiServerReadyForTesting(): void {
	ready = false;
}
