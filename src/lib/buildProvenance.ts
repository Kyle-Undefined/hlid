export type BuildCommitEvidence = {
	sha: string;
	command: string;
	output: string;
	timestamp: string;
	callId: string | null;
};

export type BuildSessionProvenance = {
	threadId: string;
	startedAt: string;
	endedAt: string;
	cwd: string;
	originator: string;
	models: string[];
	efforts: string[];
	transcriptPath: string;
	transcriptSha256: string;
	commitEvidence: BuildCommitEvidence[];
	validationCommands: string[];
};

export type BuildCommitProvenance = {
	sha: string;
	shortSha: string;
	subject: string;
	authorDate: string;
	commitDate: string;
	signatureStatus: string;
	signerFingerprint: string;
	additions: number;
	deletions: number;
	filesChanged: number;
	url: string | null;
	sessionIds: string[];
};

export type BuildProvenanceReport = {
	title: string;
	generatedAt: string;
	repository: {
		name: string;
		path: string;
		url: string | null;
		baseline: string;
		head: string;
	};
	window: { since: string; until: string };
	sessions: BuildSessionProvenance[];
	commits: BuildCommitProvenance[];
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" ? (value as JsonObject) : {};
}

function timestampOf(record: JsonObject): string {
	return typeof record.timestamp === "string" ? record.timestamp : "";
}

function collectText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value.map(collectText).filter(Boolean).join("\n");
	const object = asObject(value);
	for (const key of ["text", "output", "content", "message"]) {
		if (key in object) {
			const text = collectText(object[key]);
			if (text) return text;
		}
	}
	return "";
}

function parseJsonString(value: string): JsonObject | null {
	try {
		return asObject(JSON.parse(value));
	} catch {
		return null;
	}
}

function decodeQuoted(value: string): string {
	try {
		return JSON.parse(`"${value}"`) as string;
	} catch {
		return value;
	}
}

function commandFromInput(input: unknown): string {
	if (typeof input !== "string") {
		const object = asObject(input);
		return typeof object.cmd === "string" ? object.cmd : "";
	}
	const parsed = parseJsonString(input);
	if (typeof parsed?.cmd === "string") return parsed.cmd;
	const match = input.match(/(?:"cmd"|\bcmd)\s*:\s*"((?:\\.|[^"\\])*)"/s);
	if (match?.[1]) return decodeQuoted(match[1]);
	return input.includes("git commit") ? input : "";
}

function unquotedCommandIndex(command: string, needle: string): number {
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	for (let index = 0; index <= command.length - needle.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (!command.startsWith(needle, index)) continue;
		const before = index === 0 ? "" : command[index - 1];
		const after = command[index + needle.length] ?? "";
		if (
			(!before || /[\s;&|({]/.test(before)) &&
			(!after || /[\s:;&|)]/.test(after))
		) {
			return index;
		}
	}
	return -1;
}

function compactObservedCommand(command: string, needle: string): string {
	const normalized = command.replace(/\\n/g, "\n").replace(/\\"/g, '"');
	const index = unquotedCommandIndex(normalized, needle);
	if (index < 0) return "";
	return (
		normalized
			.slice(index, index + 500)
			.split("\n", 1)[0]
			?.trim() ?? ""
	);
}

function safeOutputExcerpt(output: string, sha: string): string {
	const normalized = output.replace(/\\n/g, "\n").replace(/\\"/g, '"');
	const at = normalized.indexOf(`[main ${sha}]`);
	const fallback = normalized.indexOf(sha);
	const start = at >= 0 ? at : Math.max(0, fallback - 40);
	const lines = normalized.slice(start).split("\n");
	const summary = lines[0]?.replace(/["}]+$/, "").trim() ?? "";
	const stats = lines[1]?.trim();
	return [summary, stats && /files? changed/.test(stats) ? stats : ""]
		.filter(Boolean)
		.join("\n");
}

function callId(payload: JsonObject): string | null {
	for (const key of ["call_id", "callId", "id"]) {
		if (typeof payload[key] === "string") return payload[key];
	}
	return null;
}

function toolCall(
	payload: JsonObject,
): { id: string | null; command: string } | null {
	if (payload.type !== "custom_tool_call" && payload.type !== "function_call") {
		return null;
	}
	const name = typeof payload.name === "string" ? payload.name : "";
	if (!/exec|command|shell/i.test(name)) return null;
	return {
		id: callId(payload),
		command: commandFromInput(payload.input ?? payload.arguments),
	};
}

function toolOutput(
	payload: JsonObject,
): { id: string | null; output: string } | null {
	if (
		payload.type !== "custom_tool_call_output" &&
		payload.type !== "function_call_output"
	) {
		return null;
	}
	return { id: callId(payload), output: collectText(payload.output) };
}

const VALIDATION_PATTERNS = [
	["bun run validate", "bun run validate"],
	["bun run build:win", "bun run build:win"],
	["bun run check", "bun run check"],
	["bun run test", "bun run test"],
	["git verify-commit", "git verify-commit"],
] as const;

function validationCommands(command: string): string[] {
	const found: string[] = [];
	for (const [needle, label] of VALIDATION_PATTERNS) {
		if (compactObservedCommand(command, needle)) found.push(label);
	}
	return found;
}

/**
 * Extracts only commit and validation evidence from a Codex rollout. User
 * prompts, developer instructions, arbitrary tool output, and environment data
 * are intentionally excluded from the shareable report model.
 */
export function extractBuildSessionProvenance(args: {
	records: JsonObject[];
	transcriptPath: string;
	transcriptSha256: string;
}): BuildSessionProvenance | null {
	const sessionRecord = args.records.find(
		(record) => record.type === "session_meta",
	);
	const session = asObject(sessionRecord?.payload);
	const threadId =
		(typeof session.id === "string" ? session.id : null) ??
		(typeof session.session_id === "string" ? session.session_id : null);
	if (!threadId) return null;

	const models = new Set<string>();
	const efforts = new Set<string>();
	const calls = new Map<string, string>();
	const anonymousCalls: string[] = [];
	const commitEvidence: BuildCommitEvidence[] = [];
	const validations = new Set<string>();
	const timestamps = args.records.map(timestampOf).filter(Boolean).sort();

	for (const record of args.records) {
		const payload = asObject(record.payload);
		if (record.type === "turn_context") {
			if (typeof payload.model === "string") models.add(payload.model);
			if (typeof payload.effort === "string") efforts.add(payload.effort);
			continue;
		}
		if (record.type !== "response_item") continue;
		const call = toolCall(payload);
		if (call) {
			for (const value of validationCommands(call.command))
				validations.add(value);
			if (call.id) calls.set(call.id, call.command);
			else anonymousCalls.push(call.command);
			continue;
		}
		const result = toolOutput(payload);
		if (!result?.output) continue;
		const command =
			(result.id ? calls.get(result.id) : null) ?? anonymousCalls.shift() ?? "";
		for (const value of validationCommands(command)) validations.add(value);
		const commitCommand = compactObservedCommand(command, "git commit");
		if (!commitCommand) continue;
		const normalizedOutput = result.output
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"');
		const matches = normalizedOutput.matchAll(
			/\[[^\]\n]+\s+([0-9a-f]{7,40})\]\s+([^\n"\\}]+)/g,
		);
		for (const match of matches) {
			const sha = match[1];
			if (!sha) continue;
			commitEvidence.push({
				sha,
				command: commitCommand,
				output: safeOutputExcerpt(normalizedOutput, sha),
				timestamp: timestampOf(record),
				callId: result.id,
			});
		}
	}

	return {
		threadId,
		startedAt:
			(typeof session.timestamp === "string" ? session.timestamp : null) ??
			timestamps[0] ??
			"",
		endedAt: timestamps.at(-1) ?? "",
		cwd: typeof session.cwd === "string" ? session.cwd : "",
		originator:
			(typeof session.originator === "string" ? session.originator : null) ??
			(typeof session.source === "string" ? session.source : null) ??
			"unknown",
		models: [...models],
		efforts: [...efforts],
		transcriptPath: args.transcriptPath,
		transcriptSha256: args.transcriptSha256,
		commitEvidence,
		validationCommands: [...validations],
	};
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function displayDate(value: string): string {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed)
		? new Date(parsed).toLocaleString("en-US", {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: value;
}

function signatureLabel(status: string): string {
	if (status === "G") return "Verified signature";
	if (status === "N") return "Unsigned";
	if (status === "U") return "Good, untrusted signature";
	return status ? `Signature ${status}` : "Unknown signature";
}

function commitCard(commit: BuildCommitProvenance): string {
	const linked = commit.sessionIds.length > 0;
	const search = [commit.sha, commit.subject, ...commit.sessionIds]
		.join(" ")
		.toLocaleLowerCase();
	const sha = commit.url
		? `<a href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">${escapeHtml(commit.shortSha)}</a>`
		: escapeHtml(commit.shortSha);
	return `<article class="commit-card" data-kind="${linked ? "linked" : "unlinked"}" data-search="${escapeHtml(search)}">
		<div class="commit-rail ${linked ? "linked" : "unlinked"}"></div>
		<div class="commit-body">
			<div class="commit-top"><span class="sha">${sha}</span><span class="badge ${linked ? "good" : "quiet"}">${linked ? "Direct transcript link" : "No direct session link"}</span></div>
			<h3>${escapeHtml(commit.subject)}</h3>
			<div class="meta"><span>${escapeHtml(displayDate(commit.commitDate))}</span><span>${escapeHtml(signatureLabel(commit.signatureStatus))}</span><span>${commit.filesChanged} files</span><span>+${commit.additions} −${commit.deletions}</span></div>
			${linked ? `<div class="chips">${commit.sessionIds.map((id) => `<button class="chip session-jump" data-session="${escapeHtml(id)}">${escapeHtml(id.slice(0, 8))}</button>`).join("")}</div>` : ""}
		</div>
	</article>`;
}

function sessionCard(session: BuildSessionProvenance): string {
	const search = [
		session.threadId,
		session.originator,
		...session.models,
		...session.commitEvidence.map((item) => item.sha),
	]
		.join(" ")
		.toLocaleLowerCase();
	const evidence = session.commitEvidence
		.map(
			(item) =>
				`<details class="evidence"><summary><span>${escapeHtml(item.sha)}</span><span>${escapeHtml(displayDate(item.timestamp))}</span></summary><div class="evidence-grid"><div><label>Command</label><pre>${escapeHtml(item.command)}</pre></div><div><label>Commit output</label><pre>${escapeHtml(item.output)}</pre></div></div></details>`,
		)
		.join("");
	return `<article class="session-card" id="session-${escapeHtml(session.threadId)}" data-search="${escapeHtml(search)}" data-models="${escapeHtml(session.models.join(" ").toLocaleLowerCase())}" data-linked="${session.commitEvidence.length > 0}">
		<div class="session-heading"><div><span class="eyebrow">${escapeHtml(session.originator)}</span><h3>${escapeHtml(session.threadId)}</h3></div><span class="badge ${session.commitEvidence.length ? "good" : "quiet"}">${session.commitEvidence.length} linked commit${session.commitEvidence.length === 1 ? "" : "s"}</span></div>
		<div class="meta"><span>${escapeHtml(displayDate(session.startedAt))}</span><span>${escapeHtml(session.models.join(", ") || "Model unavailable")}</span><span>${escapeHtml(session.efforts.join(", ") || "Effort unavailable")}</span></div>
		${session.validationCommands.length ? `<div class="validation"><label>Observed verification commands</label><div class="chips">${session.validationCommands.map((command) => `<span class="chip">${escapeHtml(command)}</span>`).join("")}</div></div>` : ""}
		${evidence || '<p class="empty">No direct commit output was found in this transcript.</p>'}
		<details class="integrity"><summary>Transcript integrity</summary><dl><dt>SHA-256</dt><dd>${escapeHtml(session.transcriptSha256)}</dd><dt>Source</dt><dd>${escapeHtml(session.transcriptPath)}</dd></dl></details>
	</article>`;
}

export function renderBuildProvenanceHtml(
	report: BuildProvenanceReport,
): string {
	const linkedCommits = report.commits.filter(
		(commit) => commit.sessionIds.length > 0,
	);
	const signedCommits = report.commits.filter(
		(commit) => commit.signatureStatus === "G",
	);
	const models = [
		...new Set(report.sessions.flatMap((session) => session.models)),
	].sort();
	const safeJson = JSON.stringify(report).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0d10;--panel:#13171c;--panel2:#181e25;--line:#2a323c;--text:#edf1f5;--muted:#98a4b3;--accent:#74d4b0;--accent2:#7aa7ff;--warn:#d8b36a;--shadow:0 18px 60px rgba(0,0,0,.28)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#17221f 0,transparent 32rem),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:44px 0 80px}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;margin-bottom:28px}.kicker,.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-size:clamp(32px,5vw,58px);line-height:1.02;margin:8px 0 12px;letter-spacing:-.045em}.hero p{max-width:760px;color:var(--muted);font-size:17px;margin:0}.window{border:1px solid var(--line);background:rgba(19,23,28,.82);padding:14px 16px;border-radius:14px;color:var(--muted);min-width:260px}.window strong{display:block;color:var(--text);margin-bottom:4px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}.stat{border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,var(--panel2),var(--panel));padding:18px;box-shadow:var(--shadow)}.stat b{display:block;font-size:30px;line-height:1;margin-bottom:8px}.stat span{color:var(--muted)}.controls{position:sticky;top:12px;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:rgba(11,13,16,.9);backdrop-filter:blur(14px);border:1px solid var(--line);padding:10px;border-radius:16px;margin:24px 0}.controls input,.controls select{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:10px 12px}.controls input{flex:1;min-width:240px}.tabs{display:flex;gap:6px}.tab{border:0;background:transparent;color:var(--muted);padding:10px 13px;border-radius:9px;cursor:pointer}.tab.active{background:var(--panel2);color:var(--text)}.count{margin-left:auto;color:var(--muted);padding:0 8px}.panel{display:none}.panel.active{display:block}.section-head{display:flex;justify-content:space-between;align-items:end;margin:28px 0 14px}.section-head h2{margin:0;font-size:24px}.section-head p{margin:0;color:var(--muted)}.commit-list,.session-list{display:grid;gap:10px}.commit-card,.session-card{border:1px solid var(--line);background:var(--panel);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}.commit-card{display:grid;grid-template-columns:5px 1fr}.commit-rail.linked{background:var(--accent)}.commit-rail.unlinked{background:#4a5360}.commit-body,.session-card{padding:18px}.commit-top,.session-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.commit-card h3,.session-card h3{margin:7px 0 8px;font-size:17px}.session-card h3{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;overflow-wrap:anywhere}.sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:750;white-space:nowrap}.badge.good{background:rgba(116,212,176,.12);color:var(--accent);border:1px solid rgba(116,212,176,.35)}.badge.quiet{background:#20262d;color:#aab4c0;border:1px solid #333c46}.meta{display:flex;gap:12px 18px;flex-wrap:wrap;color:var(--muted);font-size:13px}.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid var(--line);background:#1d242b;color:#c8d1dc;padding:5px 8px;border-radius:8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.chip.session-jump{cursor:pointer}.chip.session-jump:hover{border-color:var(--accent);color:var(--accent)}.validation{margin-top:16px}.validation label,.evidence label{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}.evidence,.integrity{border-top:1px solid var(--line);margin-top:16px;padding-top:13px}.evidence summary,.integrity summary{display:flex;justify-content:space-between;gap:14px;cursor:pointer;color:#cad3dd}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;background:#0d1115;border:1px solid #242c35;border-radius:10px;padding:12px;color:#d7e1ea;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.integrity dl{display:grid;grid-template-columns:100px 1fr;gap:7px 12px}.integrity dt{color:var(--muted)}.integrity dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.notice{border:1px solid rgba(122,167,255,.3);background:rgba(122,167,255,.08);padding:15px 17px;border-radius:14px;color:#c9d9f8}.empty{color:var(--muted)}.hidden{display:none!important}.footer{margin-top:34px;color:var(--muted);font-size:13px;text-align:center}@media(max-width:780px){.shell{width:min(100% - 20px,1180px);padding-top:24px}.hero{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}.window{min-width:0}.controls{top:6px}.evidence-grid{grid-template-columns:1fr}.commit-top,.session-heading{align-items:flex-start;flex-direction:column}.count{width:100%;margin-left:0}}@media(max-width:460px){.stats{grid-template-columns:1fr}.tabs{width:100%}.tab{flex:1}.controls input,.controls select{width:100%}}
</style></head><body><main class="shell">
<header class="hero"><div><div class="kicker">OpenAI Build Week · construction provenance</div><h1>${escapeHtml(report.title)}</h1><p>A redacted, interactive chain from Codex sessions to signed Git commits. Raw prompts, developer instructions, arbitrary tool output, and environment data are intentionally excluded.</p></div><div class="window"><strong>${escapeHtml(report.repository.name)}</strong><div>Baseline ${escapeHtml(report.repository.baseline.slice(0, 12))}</div><div>Head ${escapeHtml(report.repository.head.slice(0, 12))}</div><div>Generated ${escapeHtml(displayDate(report.generatedAt))}</div></div></header>
<div class="notice">Direct links mean the commit SHA was captured from the output of a <code>git commit</code> tool call inside that exact Codex transcript. Timestamp-only guesses are not presented as proof.</div>
<section class="stats"><div class="stat"><b>${report.sessions.length}</b><span>Codex sessions in scope</span></div><div class="stat"><b>${linkedCommits.length}</b><span>Directly linked commits</span></div><div class="stat"><b>${signedCommits.length}</b><span>Good Git signatures</span></div><div class="stat"><b>${report.commits.length}</b><span>Total commits in window</span></div></section>
<div class="controls"><div class="tabs"><button class="tab active" data-tab="commits">Commits</button><button class="tab" data-tab="sessions">Sessions</button></div><input id="search" type="search" placeholder="Search SHA, subject, session, model…" aria-label="Search provenance"><select id="model"><option value="">All models</option>${models.map((model) => `<option value="${escapeHtml(model.toLocaleLowerCase())}">${escapeHtml(model)}</option>`).join("")}</select><select id="linkage"><option value="">All evidence</option><option value="linked">Direct links</option><option value="unlinked">Unlinked commits</option></select><span class="count" id="visible-count"></span></div>
<section class="panel active" data-panel="commits"><div class="section-head"><div><h2>Commit evidence</h2><p>${escapeHtml(displayDate(report.window.since))} through ${escapeHtml(displayDate(report.window.until))}</p></div></div><div class="commit-list">${report.commits.map(commitCard).join("")}</div></section>
<section class="panel" data-panel="sessions"><div class="section-head"><div><h2>Session evidence</h2><p>Curated commit and verification records only</p></div></div><div class="session-list">${report.sessions.map(sessionCard).join("")}</div></section>
<div class="footer">Transcript fingerprints are included for private verification. This report is a generated snapshot and contains no raw transcript payload.</div>
</main><script id="report-data" type="application/json">${safeJson}</script><script>
(()=>{const search=document.querySelector('#search'),model=document.querySelector('#model'),linkage=document.querySelector('#linkage'),count=document.querySelector('#visible-count');let tab='commits';function apply(){const q=search.value.trim().toLowerCase(),m=model.value,l=linkage.value;const selector=tab==='commits'?'.commit-card':'.session-card';let visible=0;document.querySelectorAll(selector).forEach(card=>{const text=card.dataset.search||'',kind=card.dataset.kind||'',models=card.dataset.models||'',linked=card.dataset.linked==='true';const linkOk=!l||(tab==='commits'?kind===l:(l==='linked'?linked:!linked));const show=(!q||text.includes(q))&&(!m||models.includes(m)||text.includes(m))&&linkOk;card.classList.toggle('hidden',!show);if(show)visible++});count.textContent=visible+' visible'}document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{tab=button.dataset.tab;document.querySelectorAll('.tab').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.dataset.panel===tab));model.disabled=tab==='commits';apply()}));document.querySelectorAll('.session-jump').forEach(button=>button.addEventListener('click',()=>{document.querySelector('[data-tab="sessions"]').click();search.value=button.dataset.session||'';apply();document.querySelector('#session-'+CSS.escape(button.dataset.session||''))?.scrollIntoView({behavior:'smooth',block:'center'})}));[search,model,linkage].forEach(input=>input.addEventListener('input',apply));model.disabled=true;apply()})();
</script></body></html>`;
}
