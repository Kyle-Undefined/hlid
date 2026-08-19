import type { WebBrowserRecordingResult } from "./projectPreviewBrowser";

function safeJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildWebBrowserRecordingHtml(
	recording: WebBrowserRecordingResult,
): string {
	const frames = recording.frames.map((frame) => ({
		capturedAt: frame.capturedAt,
		url: frame.url,
		title: frame.title,
		width: frame.width,
		height: frame.height,
		action: frame.action ?? "capture",
		image: `data:${frame.mime};base64,${frame.imageBase64}`,
	}));
	const durationSeconds = Math.max(
		0,
		Math.round((recording.endedAt - recording.startedAt) / 100) / 10,
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hlid Browser interaction replay</title>
<style>
:root{color-scheme:light;font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f4f1;color:#191919}*{box-sizing:border-box}body{margin:0}header{padding:20px 24px;border-bottom:1px solid #d9d9d3;background:#fff}h1{font-size:18px;margin:0 0 6px}.meta{font-size:12px;color:#666}.layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;min-height:calc(100vh - 82px)}main{padding:18px;min-width:0}.stage{background:#202020;padding:12px;min-height:420px;display:grid;place-items:center}.stage img{display:block;max-width:100%;max-height:calc(100vh - 190px);box-shadow:0 8px 28px #0008}.caption{background:#fff;border:1px solid #d9d9d3;border-top:0;padding:10px 12px;font-size:12px}.url{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#555}.controls{display:flex;gap:8px;align-items:center;margin-top:12px}.controls button,.timeline button{border:1px solid #c9c9c2;background:#fff;padding:7px 10px;cursor:pointer}.controls button:disabled{opacity:.35}.count{font-size:12px;color:#666}.timeline{border-left:1px solid #d9d9d3;background:#fff;padding:14px;overflow:auto}.timeline h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#666}.timeline button{display:block;width:100%;text-align:left;margin-bottom:7px}.timeline button.active{border-color:#111;background:#efefe9}.action{font-weight:650}.time{display:block;font-size:10px;color:#777;margin-top:3px}.empty{padding:40px;color:#777}.notice{margin-top:8px;color:#9a5b00}
@media(max-width:760px){.layout{grid-template-columns:1fr}.timeline{border-left:0;border-top:1px solid #d9d9d3;max-height:280px}.stage{min-height:260px}.stage img{max-height:62vh}}
</style>
</head>
<body>
<header><h1>Hlid Browser interaction replay</h1><div class="meta">${frames.length} captured state${frames.length === 1 ? "" : "s"} · ${durationSeconds}s · started ${new Date(recording.startedAt).toISOString()}</div>${recording.truncated ? '<div class="meta notice">Recording reached its bounded duration, frame, or size limit.</div>' : ""}</header>
<div class="layout"><main><div id="viewer"></div></main><aside class="timeline"><h2>Interaction timeline</h2><div id="timeline"></div></aside></div>
<script>
const frames=${safeJson(frames)};let current=0;
const viewer=document.getElementById('viewer'),timeline=document.getElementById('timeline');
function render(){if(!frames.length){viewer.innerHTML='<div class="empty">No browser frames were captured.</div>';timeline.innerHTML='';return}const f=frames[current];viewer.innerHTML='<div class="stage"><img alt="Recorded browser state '+(current+1)+'"></div><div class="caption"><strong>'+escapeText(f.title||'Untitled')+'</strong><span class="url">'+escapeText(f.url)+'</span></div><div class="controls"><button id="prev">Previous</button><button id="next">Next</button><span class="count">'+(current+1)+' / '+frames.length+' · '+escapeText(f.action)+'</span></div>';viewer.querySelector('img').src=f.image;viewer.querySelector('#prev').disabled=current===0;viewer.querySelector('#next').disabled=current===frames.length-1;viewer.querySelector('#prev').onclick=()=>{current--;render()};viewer.querySelector('#next').onclick=()=>{current++;render()};timeline.innerHTML=frames.map((item,index)=>'<button data-index="'+index+'" class="'+(index===current?'active':'')+'"><span class="action">'+(index+1)+'. '+escapeText(item.action)+'</span><span class="time">'+new Date(item.capturedAt).toISOString()+'</span></button>').join('');timeline.querySelectorAll('button').forEach(button=>button.onclick=()=>{current=Number(button.dataset.index);render()})}
function escapeText(value){const span=document.createElement('span');span.textContent=String(value);return span.innerHTML}render();
</script>
</body>
</html>`;
}
