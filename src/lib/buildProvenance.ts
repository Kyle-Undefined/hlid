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
	toolCalls: number;
	toolCounts: { name: string; count: number }[];
	usage: BuildTokenUsage;
	inBuildWeek: boolean;
};

export type BuildTokenUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type BuildCommitProvenance = {
	sha: string;
	shortSha: string;
	subject: string;
	authorDate: string;
	commitDate: string;
	authorName: string;
	authorEmail: string;
	coAuthors: { name: string; email: string }[];
	signatureStatus: string;
	signerFingerprint: string;
	additions: number;
	deletions: number;
	filesChanged: number;
	url: string | null;
	sessionIds: string[];
	inBuildWeek: boolean;
};

export type BuildContributor = {
	name: string;
	email: string;
	aliases: string[];
	commits: number;
	buildWeekCommits: number;
	primaryCommits: number;
	coauthoredCommits: number;
	sessionLinkedCommits: number;
	buildWeekSessionLinkedCommits: number;
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
	contributors: BuildContributor[];
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

function toolName(payload: JsonObject): string | null {
	if (payload.type !== "custom_tool_call" && payload.type !== "function_call") {
		return null;
	}
	return typeof payload.name === "string" && payload.name.trim()
		? payload.name.trim()
		: "unknown";
}

function numericField(
	object: JsonObject,
	snake: string,
	camel: string,
): number {
	const value = object[snake] ?? object[camel];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenUsage(payload: JsonObject): BuildTokenUsage | null {
	if (payload.type !== "token_count") return null;
	const info = asObject(payload.info);
	const total = asObject(info.total_token_usage ?? info.totalTokenUsage);
	if (!Object.keys(total).length) return null;
	return {
		inputTokens: numericField(total, "input_tokens", "inputTokens"),
		cachedInputTokens: numericField(
			total,
			"cached_input_tokens",
			"cachedInputTokens",
		),
		outputTokens: numericField(total, "output_tokens", "outputTokens"),
		reasoningOutputTokens: numericField(
			total,
			"reasoning_output_tokens",
			"reasoningOutputTokens",
		),
		totalTokens: numericField(total, "total_tokens", "totalTokens"),
	};
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
	const toolCounts = new Map<string, number>();
	let usage: BuildTokenUsage = {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
	const timestamps = args.records.map(timestampOf).filter(Boolean).sort();

	for (const record of args.records) {
		const payload = asObject(record.payload);
		const observedUsage = tokenUsage(payload);
		if (observedUsage) usage = observedUsage;
		if (record.type === "turn_context") {
			if (typeof payload.model === "string") models.add(payload.model);
			if (typeof payload.effort === "string") efforts.add(payload.effort);
			continue;
		}
		if (record.type !== "response_item") continue;
		const observedTool = toolName(payload);
		if (observedTool) {
			toolCounts.set(observedTool, (toolCounts.get(observedTool) ?? 0) + 1);
		}
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
		toolCalls: [...toolCounts.values()].reduce((sum, count) => sum + count, 0),
		toolCounts: [...toolCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		usage,
		inBuildWeek: false,
	};
}

/**
 * Extracts the same privacy-limited evidence from a Claude transcript. Usage is
 * supplied by the provider-history planner, which owns streamed-message and
 * fork deduplication; assistantMessageIds limits tools to those owned calls.
 */
export function extractClaudeBuildSessionProvenance(args: {
	threadId: string;
	startedAt: string;
	endedAt: string;
	cwd: string;
	originator: string;
	models: string[];
	usage: BuildTokenUsage;
	records: JsonObject[];
	assistantMessageIds: string[];
	transcriptPath: string;
	transcriptSha256: string;
}): BuildSessionProvenance {
	const ownedMessages = new Set(args.assistantMessageIds);
	const calls = new Map<
		string,
		{ command: string; name: string; timestamp: string }
	>();
	const results = new Map<string, { output: string; timestamp: string }>();
	const efforts = new Set<string>();
	const validations = new Set<string>();

	for (const record of args.records) {
		if (typeof record.effort === "string") efforts.add(record.effort);
		const message = asObject(record.message);
		const messageId = typeof message.id === "string" ? message.id : null;
		const content = Array.isArray(message.content) ? message.content : [];
		if (
			record.type === "assistant" &&
			messageId &&
			ownedMessages.has(messageId)
		) {
			for (const item of content) {
				const block = asObject(item);
				if (block.type !== "tool_use" || typeof block.id !== "string") continue;
				const input = asObject(block.input);
				const command =
					typeof input.command === "string"
						? input.command
						: typeof input.cmd === "string"
							? input.cmd
							: "";
				calls.set(block.id, {
					command,
					name:
						typeof block.name === "string" && block.name.trim()
							? block.name.trim()
							: "unknown",
					timestamp: timestampOf(record),
				});
			}
		}
		if (record.type !== "user") continue;
		for (const item of content) {
			const block = asObject(item);
			if (block.type !== "tool_result") continue;
			const id =
				typeof block.tool_use_id === "string" ? block.tool_use_id : null;
			if (!id || !calls.has(id)) continue;
			results.set(id, {
				output: collectText(block.content || record.toolUseResult),
				timestamp: timestampOf(record),
			});
		}
	}

	const toolCounts = new Map<string, number>();
	const commitEvidence: BuildCommitEvidence[] = [];
	for (const [id, call] of calls) {
		toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
		for (const value of validationCommands(call.command))
			validations.add(value);
		const commitCommand = compactObservedCommand(call.command, "git commit");
		const result = results.get(id);
		if (!commitCommand || !result?.output) continue;
		const normalizedOutput = result.output
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"');
		for (const match of normalizedOutput.matchAll(
			/\[[^\]\n]+\s+([0-9a-f]{7,40})\]\s+([^\n"\\}]+)/g,
		)) {
			const sha = match[1];
			if (!sha) continue;
			commitEvidence.push({
				sha,
				command: commitCommand,
				output: safeOutputExcerpt(normalizedOutput, sha),
				timestamp: result.timestamp || call.timestamp,
				callId: id,
			});
		}
	}

	return {
		threadId: args.threadId,
		startedAt: args.startedAt,
		endedAt: args.endedAt,
		cwd: args.cwd,
		originator: args.originator,
		models: [...new Set(args.models)].filter(
			(model) => model !== "<synthetic>",
		),
		efforts: [...efforts],
		transcriptPath: args.transcriptPath,
		transcriptSha256: args.transcriptSha256,
		commitEvidence,
		validationCommands: [...validations],
		toolCalls: calls.size,
		toolCounts: [...toolCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		usage: args.usage,
		inBuildWeek: false,
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

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value: number): string {
	return new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 2,
	}).format(value);
}

function displayDay(value: string): string {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed)
		? new Date(parsed).toLocaleDateString("en-US", {
				weekday: "short",
				month: "short",
				day: "numeric",
				year: "numeric",
			})
		: value;
}

function compactCommit(commit: BuildCommitProvenance): string {
	const sha = commit.url
		? `<a href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">${escapeHtml(commit.shortSha)}</a>`
		: escapeHtml(commit.shortSha);
	return `<li class="commit-branch${commit.inBuildWeek ? " build-week" : ""}" title="${escapeHtml(`${displayDate(commit.commitDate)} · ${signatureLabel(commit.signatureStatus)} · ${commit.filesChanged} files · +${commit.additions} −${commit.deletions}`)}"><span class="branch-mark" aria-hidden="true">└</span><span class="sha">${sha}</span><span class="commit-subject">${escapeHtml(commit.subject)}</span>${commit.inBuildWeek ? '<span class="week-mark">BW</span>' : ""}</li>`;
}

function sessionProof(session: BuildSessionProvenance): string {
	const tools = session.toolCounts
		.map((tool) => `<span>${escapeHtml(tool.name)} × ${tool.count}</span>`)
		.join("");
	const evidence = session.commitEvidence
		.map(
			(item) =>
				`<details class="commit-proof"><summary>${escapeHtml(item.sha.slice(0, 12))} · ${escapeHtml(displayDate(item.timestamp))}</summary><div class="proof-grid"><div><label>Command</label><pre>${escapeHtml(item.command)}</pre></div><div><label>Commit output</label><pre>${escapeHtml(item.output)}</pre></div></div></details>`,
		)
		.join("");
	return `<details class="session-proof"><summary>Transcript proof and usage detail</summary><div class="proof-body"><div class="usage-detail"><span>Input ${formatNumber(session.usage.inputTokens)}</span><span>Cached ${formatNumber(session.usage.cachedInputTokens)}</span><span>Output ${formatNumber(session.usage.outputTokens)}</span><span>Reasoning ${formatNumber(session.usage.reasoningOutputTokens)}</span></div>${tools ? `<div class="tool-detail">${tools}</div>` : ""}${session.validationCommands.length ? `<div class="validation-detail"><strong>Verification</strong>${session.validationCommands.map((command) => `<code>${escapeHtml(command)}</code>`).join("")}</div>` : ""}${evidence}<dl class="integrity"><dt>SHA-256</dt><dd>${escapeHtml(session.transcriptSha256)}</dd><dt>Source</dt><dd>${escapeHtml(session.transcriptPath)}</dd></dl></div></details>`;
}

function compactSessionCard(
	session: BuildSessionProvenance,
	commits: BuildCommitProvenance[],
): string {
	const sortedCommits = [...commits].sort((a, b) =>
		b.commitDate.localeCompare(a.commitDate),
	);
	const visible = sortedCommits.slice(0, 4);
	const hidden = sortedCommits.slice(4);
	return `<article class="build-session${session.inBuildWeek ? " build-week" : ""}"><header><div><span class="model">${escapeHtml(session.models.join(", ") || "Model unavailable")}</span><span>${escapeHtml(displayDate(session.startedAt))}</span></div><strong>${sortedCommits.length} commit${sortedCommits.length === 1 ? "" : "s"}</strong></header><code class="session-id" title="${escapeHtml(session.threadId)}">${escapeHtml(session.threadId)}</code><div class="session-metrics"><span><b title="${formatNumber(session.usage.totalTokens)}">${formatCompactNumber(session.usage.totalTokens)}</b> tokens</span><span><b>${formatNumber(session.toolCalls)}</b> calls</span><span><b>${escapeHtml(session.efforts.join(", ") || "n/a")}</b> effort</span></div><ul class="commit-branches">${visible.map(compactCommit).join("")}</ul>${hidden.length ? `<details class="more-commits"><summary>+${hidden.length} more commit${hidden.length === 1 ? "" : "s"}</summary><ul class="commit-branches">${hidden.map(compactCommit).join("")}</ul></details>` : ""}${sessionProof(session)}</article>`;
}

type LinkedModelSummary = {
	model: string;
	sessions: number;
	commits: number;
	tokens: number;
	toolCalls: number;
};

function linkedModelCard(summary: LinkedModelSummary): string {
	return `<article class="model-card"><strong>${escapeHtml(summary.model)}</strong><span>${formatNumber(summary.sessions)} sessions</span><span>${formatNumber(summary.commits)} commits</span><span title="${formatNumber(summary.tokens)}">${formatCompactNumber(summary.tokens)} tokens</span><span>${formatNumber(summary.toolCalls)} calls</span></article>`;
}

function contributorRow(contributor: BuildContributor): string {
	const aliases = contributor.aliases.length
		? ` · ${escapeHtml(contributor.aliases.join(", "))}`
		: "";
	return `<div class="contributor-row"><div><strong>${escapeHtml(contributor.name)}</strong><span>${contributor.primaryCommits ? "Primary Git author" : "GitHub-recognized co-author"}${aliases}</span></div><span>${formatNumber(contributor.commits)} credited · ${formatNumber(contributor.buildWeekCommits)} Build Week</span></div>`;
}

function sessionCollection(
	sessions: BuildSessionProvenance[],
	commitsBySession: Map<string, BuildCommitProvenance[]>,
): string {
	return sessions
		.map((session) =>
			compactSessionCard(session, commitsBySession.get(session.threadId) ?? []),
		)
		.join("");
}

function dayGroup(
	label: string,
	sessions: BuildSessionProvenance[],
	commitsBySession: Map<string, BuildCommitProvenance[]>,
	open: boolean,
): string {
	const commits = sessions.reduce(
		(sum, session) =>
			sum + (commitsBySession.get(session.threadId)?.length ?? 0),
		0,
	);
	const tokens = sessions.reduce(
		(sum, session) => sum + session.usage.totalTokens,
		0,
	);
	const calls = sessions.reduce((sum, session) => sum + session.toolCalls, 0);
	return `<details class="day-group"${open ? " open" : ""}><summary><strong>${escapeHtml(label)}</strong><span>${formatNumber(sessions.length)} sessions · ${formatNumber(commits)} commits · ${formatCompactNumber(tokens)} tokens · ${formatNumber(calls)} calls</span></summary><div class="session-grid">${sessionCollection(sessions, commitsBySession)}</div></details>`;
}

export function renderBuildProvenanceHtml(
	report: BuildProvenanceReport,
): string {
	const signedCommits = report.commits.filter(
		(commit) => commit.signatureStatus === "G",
	);
	const buildWeekCommits = report.commits.filter(
		(commit) => commit.inBuildWeek,
	);
	const preEventCommits = report.commits.length - buildWeekCommits.length;
	const gpt56BuildWeekSessions = report.sessions.filter(
		(session) =>
			session.inBuildWeek &&
			session.models.some((model) =>
				model.toLocaleLowerCase().includes("gpt-5.6"),
			),
	);
	const buildWeekTokens = gpt56BuildWeekSessions.reduce(
		(sum, session) => sum + session.usage.totalTokens,
		0,
	);
	const buildWeekToolCalls = gpt56BuildWeekSessions.reduce(
		(sum, session) => sum + session.toolCalls,
		0,
	);
	const sessionsById = new Map(
		report.sessions.map((session) => [session.threadId, session]),
	);
	const commitsNewestFirst = [...report.commits].sort((a, b) =>
		b.commitDate.localeCompare(a.commitDate),
	);
	const sessionsNewestFirst = [...report.sessions].sort((a, b) =>
		b.startedAt.localeCompare(a.startedAt),
	);
	const commitsBySession = new Map<string, BuildCommitProvenance[]>();
	const groupedCommitShas = new Set<string>();
	for (const commit of commitsNewestFirst) {
		const primarySessionId = commit.sessionIds.find((sessionId) =>
			sessionsById.has(sessionId),
		);
		if (!primarySessionId) continue;
		const commits = commitsBySession.get(primarySessionId) ?? [];
		commits.push(commit);
		commitsBySession.set(primarySessionId, commits);
		groupedCommitShas.add(commit.sha);
	}
	const linkedSessions = sessionsNewestFirst.filter((session) =>
		commitsBySession.has(session.threadId),
	);
	const buildWeekLinkedSessions = linkedSessions.filter((session) =>
		commitsBySession
			.get(session.threadId)
			?.some((commit) => commit.inBuildWeek),
	);
	const earlierLinkedSessions = linkedSessions.filter(
		(session) => !buildWeekLinkedSessions.includes(session),
	);
	const unlinkedCommits = commitsNewestFirst.filter(
		(commit) => !groupedCommitShas.has(commit.sha),
	);
	const linkedModelSummaries = new Map<
		string,
		LinkedModelSummary & { shas: Set<string> }
	>();
	for (const session of linkedSessions) {
		const commits = commitsBySession.get(session.threadId) ?? [];
		for (const model of session.models) {
			const existing = linkedModelSummaries.get(model) ?? {
				model,
				sessions: 0,
				commits: 0,
				tokens: 0,
				toolCalls: 0,
				shas: new Set<string>(),
			};
			existing.sessions++;
			existing.tokens += session.usage.totalTokens;
			existing.toolCalls += session.toolCalls;
			for (const commit of commits) existing.shas.add(commit.sha);
			existing.commits = existing.shas.size;
			linkedModelSummaries.set(model, existing);
		}
	}
	const otherLinkedModels = [...linkedModelSummaries.values()]
		.filter((summary) => !summary.model.toLocaleLowerCase().includes("gpt-5.6"))
		.sort((a, b) => b.commits - a.commits || a.model.localeCompare(b.model));
	const sessionsByDay = new Map<string, BuildSessionProvenance[]>();
	for (const session of buildWeekLinkedSessions) {
		const newestBuildWeekCommit = commitsBySession
			.get(session.threadId)
			?.find((commit) => commit.inBuildWeek);
		const key = displayDay(
			newestBuildWeekCommit?.commitDate ?? session.startedAt,
		);
		const sessions = sessionsByDay.get(key) ?? [];
		sessions.push(session);
		sessionsByDay.set(key, sessions);
	}
	const dayEntries = [...sessionsByDay.entries()];
	const busiestDay = dayEntries.reduce<
		[string, BuildSessionProvenance[]] | null
	>((busiest, entry) => {
		const commitCount = (sessions: BuildSessionProvenance[]) =>
			sessions.reduce(
				(sum, session) =>
					sum + (commitsBySession.get(session.threadId)?.length ?? 0),
				0,
			);
		return !busiest || commitCount(entry[1]) > commitCount(busiest[1])
			? entry
			: busiest;
	}, null);
	const buildWeekDayGroups = dayEntries.map(([label, sessions]) =>
		dayGroup(label, sessions, commitsBySession, label === busiestDay?.[0]),
	);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title>
	<style>
	:root{color-scheme:dark;--bg:#0b0d10;--panel:#13171c;--panel2:#181e25;--line:#2a323c;--text:#edf1f5;--muted:#98a4b3;--accent:#74d4b0;--accent2:#7aa7ff;--warn:#e7b85c;--shadow:0 18px 60px rgba(0,0,0,.28)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#17221f 0,transparent 32rem),var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}.shell{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:44px 0 80px}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;margin-bottom:28px}.kicker,.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-size:clamp(32px,5vw,58px);line-height:1.02;margin:8px 0 12px;letter-spacing:-.045em}.hero p{max-width:760px;color:var(--muted);font-size:17px;margin:0}.window{border:1px solid var(--line);background:rgba(19,23,28,.82);padding:14px 16px;border-radius:14px;color:var(--muted);min-width:260px}.window strong{display:block;color:var(--text);margin-bottom:4px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}.stat{border:1px solid var(--line);border-radius:16px;background:linear-gradient(145deg,var(--panel2),var(--panel));padding:18px;box-shadow:var(--shadow)}.stat.build-week{border-color:rgba(231,184,92,.38);background:linear-gradient(145deg,rgba(231,184,92,.1),var(--panel))}.stat b{display:block;font-size:30px;line-height:1;margin-bottom:8px}.stat span{color:var(--muted)}.controls{position:sticky;top:12px;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:rgba(11,13,16,.9);backdrop-filter:blur(14px);border:1px solid var(--line);padding:10px;border-radius:16px;margin:24px 0}.controls input,.controls select{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:10px 12px}.controls input{flex:1;min-width:220px}.tabs{display:flex;gap:6px}.tab{border:0;background:transparent;color:var(--muted);padding:10px 13px;border-radius:9px;cursor:pointer}.tab.active{background:var(--panel2);color:var(--text)}.count{margin-left:auto;color:var(--muted);padding:0 8px}.panel{display:none}.panel.active{display:block}.section-head{display:flex;justify-content:space-between;align-items:end;margin:28px 0 14px}.section-head h2{margin:0;font-size:24px}.section-head p{margin:0;color:var(--muted)}.commit-list,.session-list,.contributor-list{display:grid;gap:10px}.commit-card,.session-card,.contributor-card{border:1px solid var(--line);background:var(--panel);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}.commit-card{display:grid;grid-template-columns:5px 1fr}.commit-card.build-week,.session-card.build-week{border-color:rgba(231,184,92,.4);background:linear-gradient(120deg,rgba(231,184,92,.07),var(--panel) 38%)}.commit-rail.linked{background:var(--accent)}.commit-rail.unlinked{background:#4a5360}.commit-rail.build-week{background:var(--warn)}.commit-body,.session-card{padding:18px}.commit-top,.session-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.commit-top>div,.session-heading>div{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.commit-card h3,.session-card h3,.contributor-card h3{margin:7px 0 8px;font-size:17px}.session-card h3{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;overflow-wrap:anywhere}.sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:800}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:750;white-space:nowrap}.badge.good{background:rgba(116,212,176,.12);color:var(--accent);border:1px solid rgba(116,212,176,.35)}.badge.quiet{background:#20262d;color:#aab4c0;border:1px solid #333c46}.badge.week{background:rgba(231,184,92,.12);color:var(--warn);border:1px solid rgba(231,184,92,.38);margin-left:8px}.meta{display:flex;gap:12px 18px;flex-wrap:wrap;color:var(--muted);font-size:13px}.usage-breakdown,.linked-usage{display:flex;gap:8px 14px;align-items:center;flex-wrap:wrap;margin-top:10px;color:#c7d0da;font-size:12px}.usage-breakdown span,.linked-usage span{border-left:2px solid var(--line);padding-left:8px}.linked-usage small{color:var(--muted)}.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid var(--line);background:#1d242b;color:#c8d1dc;padding:5px 8px;border-radius:8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.chip.session-jump{cursor:pointer}.chip.session-jump:hover{border-color:var(--accent);color:var(--accent)}.validation{margin-top:16px}.validation label,.evidence label{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}.evidence,.integrity{border-top:1px solid var(--line);margin-top:16px;padding-top:13px}.evidence summary,.integrity summary{display:flex;justify-content:space-between;gap:14px;cursor:pointer;color:#cad3dd}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;background:#0d1115;border:1px solid #242c35;border-radius:10px;padding:12px;color:#d7e1ea;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.integrity dl{display:grid;grid-template-columns:100px 1fr;gap:7px 12px}.integrity dt{color:var(--muted)}.integrity dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.contributor-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:24px;align-items:center;padding:18px}.contributor-count{display:grid;text-align:right}.contributor-count b{font-size:24px}.contributor-count span{color:var(--muted);font-size:12px}.week-count b{color:var(--warn)}.notice{border:1px solid rgba(122,167,255,.3);background:rgba(122,167,255,.08);padding:15px 17px;border-radius:14px;color:#c9d9f8}.empty{color:var(--muted)}.hidden{display:none!important}.footer{margin-top:34px;color:var(--muted);font-size:13px;text-align:center}@media(max-width:780px){.shell{width:min(100% - 20px,1180px);padding-top:24px}.hero{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}.window{min-width:0}.controls{top:6px}.evidence-grid{grid-template-columns:1fr}.commit-top,.session-heading{align-items:flex-start;flex-direction:column}.count{width:100%;margin-left:0}.contributor-card{grid-template-columns:1fr 1fr}.contributor-card>div:first-child{grid-column:1/-1}}@media(max-width:460px){.stats{grid-template-columns:1fr}.tabs{width:100%;flex-wrap:wrap}.tab{flex:1}.controls input,.controls select{width:100%}}

	/* Hlid tan theme: parchment surfaces, brown ink, and one amber eligibility aperture. */
	:root{color-scheme:light;--paper:#f0e6d3;--paper-high:#f5ede0;--paper-low:#e4d4ba;--ink:#2a1a10;--fjord:#4d2c18;--muted:#6b4c36;--line:#c5a882;--verdigris:#8c4e35;--ice:#b89870;--amber:#a65f00;--amber-soft:#ead1a2;--seal:#b03a2e;--shadow:0 18px 44px rgba(42,26,16,.10)}
	*{box-sizing:border-box}
	html{scroll-behavior:smooth}
	body{margin:0;color:var(--ink);font:16px/1.58 "Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif;background-color:var(--paper);background-image:linear-gradient(rgba(42,26,16,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(42,26,16,.045) 1px,transparent 1px),radial-gradient(circle at 88% 2%,rgba(140,78,53,.16),transparent 34rem);background-size:36px 36px,36px 36px,auto}
	a{color:var(--fjord);text-decoration-thickness:1px;text-underline-offset:3px}
	a:hover{color:var(--verdigris)}
	button,input,select,h1,h2,h3{font-family:Bahnschrift,"Arial Narrow","Aptos Display",sans-serif}
	button,input,select{font-size:14px}
	button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid var(--amber);outline-offset:3px}
	.shell{width:min(1280px,calc(100% - 44px));margin:0 auto;padding:42px 0 88px}
	.hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:38px;align-items:end;margin:0;padding:36px 0 30px;border-top:8px solid var(--ink);border-bottom:1px solid var(--ink)}
	.hero-copy{min-width:0}
	.kicker,.eyebrow{color:var(--verdigris);font:700 11px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.16em;text-transform:uppercase}
	.hero h1{max-width:850px;margin:10px 0 14px;color:var(--ink);font-size:clamp(54px,8.2vw,112px);font-weight:720;line-height:.82;letter-spacing:-.07em}
	.hero h1 .name:first-child{color:var(--fjord)}
	.hero h1 .name:last-child{color:var(--verdigris)}
	.hero p{max-width:750px;margin:0;color:#4d2c18;font-size:clamp(17px,2vw,22px);line-height:1.45}
	.window{min-width:0;padding:20px 22px;color:#f5ede0;background:var(--ink);border:0;border-radius:0;clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,0 100%);font:12px/1.75 "Cascadia Mono","SFMono-Regular",Consolas,monospace;box-shadow:var(--shadow)}
	.window strong{display:block;margin-bottom:8px;color:#fffaf2;font:700 22px/1 Bahnschrift,"Arial Narrow",sans-serif;letter-spacing:.04em;text-transform:uppercase}
	.aperture-wrap{grid-column:1/-1;margin-top:8px}
	.aperture-label{display:flex;justify-content:space-between;margin-bottom:7px;color:var(--muted);font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}
	.aperture{display:grid;min-height:68px;border:1px solid var(--ink);box-shadow:5px 5px 0 rgba(42,26,16,.12)}
	.aperture>div{display:flex;align-items:end;justify-content:space-between;gap:12px;padding:12px 16px}
	.aperture-before{color:#f5ede0;background:var(--fjord)}
	.aperture-week{position:relative;color:var(--ink);background:repeating-linear-gradient(-45deg,var(--amber-soft),var(--amber-soft) 10px,#ddb66d 10px,#ddb66d 20px);border-left:5px solid var(--amber)}
	.aperture b{font:720 28px/1 Bahnschrift,"Arial Narrow",sans-serif}
	.aperture span{font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
	.method-note{display:grid;grid-template-columns:180px 1fr;gap:24px;margin:26px 0 0;padding:18px 0;border-bottom:1px solid var(--line)}
	.method-note strong{font:720 18px/1.1 Bahnschrift,"Arial Narrow",sans-serif;text-transform:uppercase}
	.method-note p{margin:0;color:#5d3b28}
	.method-note code{font-family:"Cascadia Mono","SFMono-Regular",Consolas,monospace;color:var(--seal)}
	.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;margin:0 0 30px;border-bottom:1px solid var(--ink)}
	.stat,.stat.build-week{min-width:0;padding:20px 16px 18px;background:rgba(245,237,224,.62);border:0;border-right:1px solid var(--line);border-radius:0;box-shadow:none}
	.stat:first-child{border-left:1px solid var(--line)}
	.stat.build-week{background:rgba(234,209,162,.72)}
	.stat b{display:block;margin:0 0 8px;color:var(--ink);font:720 clamp(24px,3vw,42px)/.95 Bahnschrift,"Arial Narrow",sans-serif;letter-spacing:-.04em;overflow-wrap:anywhere}
	.stat span{display:block;color:#5d3b28;font:700 10px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.06em;text-transform:uppercase}
	.model-register{display:flex;gap:10px 24px;align-items:center;flex-wrap:wrap;margin:-16px 0 30px;padding:12px 16px;color:#5d3b28;background:rgba(221,208,181,.7);border:1px solid var(--line);font:700 11px/1.45 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.model-register strong{color:var(--fjord);text-transform:uppercase;letter-spacing:.08em}
	.model-register span:last-child{margin-left:auto;color:var(--muted)}
	.controls{position:sticky;top:10px;z-index:5;display:grid;grid-template-columns:auto minmax(210px,1fr) repeat(3,auto) auto;gap:8px;align-items:center;margin:0 0 34px;padding:9px;background:rgba(245,237,224,.94);border:1px solid var(--ink);border-radius:0;box-shadow:6px 6px 0 rgba(42,26,16,.14);backdrop-filter:blur(14px)}
	.tabs{display:flex;gap:0}
	.tab{position:relative;padding:10px 13px;color:var(--muted);background:transparent;border:0;border-radius:0;cursor:pointer;font-weight:700;letter-spacing:.02em}
	.tab::after{content:"";position:absolute;right:12px;bottom:3px;left:12px;height:3px;background:transparent}
	.tab.active{color:var(--ink);background:transparent}
	.tab.active::after{background:var(--amber)}
	.controls input,.controls select{min-height:42px;padding:9px 11px;color:var(--ink);background:var(--paper-high);border:1px solid var(--line);border-radius:0}
	.controls input{min-width:0}
	.controls select:disabled{color:#8a735f;background:var(--paper-low)}
	.count{margin:0;padding:0 8px;color:var(--muted);font:700 11px/1 "Cascadia Mono","SFMono-Regular",Consolas,monospace;white-space:nowrap}
	.panel{display:none}
	.panel.active{display:block}
	.section-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,440px);gap:24px;align-items:end;margin:0 0 18px;padding-bottom:13px;border-bottom:3px solid var(--ink)}
	.section-head h2{margin:0;color:var(--ink);font-size:clamp(32px,5vw,58px);font-weight:720;line-height:.9;letter-spacing:-.045em}
	.section-head p{margin:0;color:var(--muted);text-align:right;font-size:14px}
	.commit-list,.session-list,.contributor-list{display:grid;gap:12px}
	.session-commit-group{overflow:hidden;background:rgba(245,237,224,.88);border:1px solid var(--fjord);box-shadow:5px 5px 0 rgba(42,26,16,.11)}
	.session-commit-group.build-week{border-color:#a65f00}
	.session-group-header{padding:22px 24px;color:#f5ede0;background:var(--fjord);border-left:10px solid var(--verdigris)}
	.session-commit-group.build-week .session-group-header{border-left-color:var(--amber);background:linear-gradient(110deg,var(--fjord),#6f4330)}
	.session-group-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
	.session-group-heading>div{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
	.session-group-header .eyebrow{color:#e6c9b4}
	.session-group-header h3{margin:12px 0 10px;color:#fffaf2;font:700 14px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}
	.session-group-header .meta{color:#dcc7b3}
	.session-group-header .meta span::before{color:#bd9679}
	.session-totals{display:flex;gap:12px 26px;flex-wrap:wrap;margin-top:18px}
	.session-totals span{color:#eadccc;font:700 11px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}
	.session-totals b{display:inline-block;margin-right:6px;color:#fffaf2;font:720 25px/1 Bahnschrift,"Arial Narrow",sans-serif;letter-spacing:-.02em}
	.session-group-header .usage-breakdown{color:#f5ede0}
	.session-group-header .usage-breakdown span{border-left-color:var(--amber)}
	.session-tools{margin-top:16px}
	.session-tools label{display:block;margin-bottom:7px;color:#d8bea9;font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}
	.session-group-header .chip{color:#f5ede0;background:rgba(255,255,255,.08);border-color:#9b765e}
	.session-group-header .session-jump{margin-top:15px;color:#2a1a10;background:#ddd0b5;border-color:#ddd0b5}
	.timeline-reference{margin:14px 0 0;color:var(--muted);font:700 11px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.grouped-commits{display:grid;gap:0}
	.grouped-commit{padding:17px 24px 18px;border-top:1px solid var(--line);background:rgba(245,237,224,.9)}
	.grouped-commit.build-week{background:linear-gradient(90deg,rgba(234,209,162,.7),rgba(245,237,224,.92) 45%)}
	.grouped-commit-heading{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font:700 11px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.grouped-commit-heading>div{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
	.grouped-commit h4{margin:8px 0 9px;color:var(--ink);font:680 clamp(17px,2vw,22px)/1.15 Bahnschrift,"Arial Narrow",sans-serif;letter-spacing:-.015em}
	.commit-card,.session-card,.contributor-card{position:relative;overflow:hidden;color:var(--ink);background:rgba(245,237,224,.84);border:1px solid var(--line);border-radius:0;box-shadow:3px 3px 0 rgba(42,26,16,.08);transition:transform 150ms ease,box-shadow 150ms ease,border-color 150ms ease}
	.commit-card:hover,.session-card:hover,.contributor-card:hover{transform:translate(-2px,-2px);border-color:var(--fjord);box-shadow:7px 7px 0 rgba(42,26,16,.12)}
	.commit-card{display:grid;grid-template-columns:10px 1fr}
	.commit-card.build-week,.session-card.build-week{background:linear-gradient(90deg,rgba(234,209,162,.84),rgba(245,237,224,.9) 38%);border-color:#b89870}
	.commit-rail.linked{background:var(--verdigris)}
	.commit-rail.unlinked{background:var(--ice)}
	.commit-rail.build-week{background:repeating-linear-gradient(0deg,var(--amber),var(--amber) 8px,#75410b 8px,#75410b 14px)}
	.commit-body,.session-card{padding:20px 22px}
	.session-card{border-left:10px solid var(--ice)}
	.session-card.build-week{border-left-color:var(--amber)}
	.commit-top,.session-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
	.commit-top>div,.session-heading>div{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
	.commit-card h3,.session-card h3,.contributor-card h3{margin:9px 0 10px;color:var(--ink);font-size:clamp(18px,2.2vw,25px);font-weight:680;line-height:1.12;letter-spacing:-.02em}
	.session-card h3{width:100%;font:700 14px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}
	.sha{font:800 13px/1 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.02em}
	.badge{display:inline-flex;align-items:center;padding:5px 8px;border-radius:0;font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,0 100%)}
	.badge.good{color:#28572d;background:#cfe2c6;border:0}
	.badge.quiet{color:#5b4939;background:#e4d4ba;border:0}
	.badge.week{margin-left:0;color:#633800;background:var(--amber-soft);border:0}
	.meta{display:flex;gap:6px 18px;flex-wrap:wrap;color:#6b4c36;font:700 11px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.meta span::before{content:"·";margin-right:8px;color:var(--ice)}
	.meta span:first-child::before{display:none}
	.usage-breakdown,.linked-usage{display:flex;gap:8px 16px;align-items:center;flex-wrap:wrap;margin-top:12px;color:#4d2c18;font:700 11px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.usage-breakdown span,.linked-usage span{padding-left:8px;border-left:3px solid var(--ice)}
	.linked-usage small{color:var(--muted)}
	.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
	.chip{padding:5px 8px;color:#4d2c18;background:#e4d4ba;border:1px solid var(--line);border-radius:0;font:700 11px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.chip.session-jump{cursor:pointer}
	.chip.session-jump:hover{color:#fffaf2;background:var(--fjord);border-color:var(--fjord)}
	.validation{margin-top:18px}
	.validation label,.evidence label{display:block;margin-bottom:7px;color:var(--muted);font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}
	.evidence,.integrity{margin-top:17px;padding-top:13px;border-top:1px solid var(--line)}
	.evidence summary,.integrity summary{display:flex;justify-content:space-between;gap:14px;min-width:0;color:#4d2c18;cursor:pointer;font:700 11px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.evidence summary span{min-width:0;overflow-wrap:anywhere}
	.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
	pre{margin:0;padding:13px;color:#f5ede0;background:var(--ink);border:0;border-radius:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.integrity dl{display:grid;grid-template-columns:100px 1fr;gap:7px 12px}
	.integrity dt{color:var(--muted)}
	.integrity dd{margin:0;font:11px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}
	.contributor-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:30px;align-items:center;padding:24px;border-left:10px solid var(--verdigris)}
	.contributor-aliases{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
	.contributor-count{display:grid;text-align:right}
	.contributor-count b{color:var(--fjord);font:720 32px/1 Bahnschrift,"Arial Narrow",sans-serif}
	.contributor-count span{color:var(--muted);font:700 10px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}
	.week-count b{color:var(--amber)}
	.contributor-evidence{grid-column:1/-1;display:flex;justify-content:space-between;gap:10px 24px;flex-wrap:wrap;padding-top:13px;color:var(--muted);border-top:1px solid var(--line);font:700 10px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}
	.empty{color:var(--muted)}
	.hidden{display:none!important}
	.footer{margin-top:42px;padding-top:16px;color:var(--muted);border-top:1px solid var(--ink);font:700 10px/1.6 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.05em;text-align:left;text-transform:uppercase}
	@keyframes aperture-settle{from{transform:translateY(8px)}to{transform:none}}
	.aperture-wrap{animation:aperture-settle 420ms both cubic-bezier(.2,.7,.2,1)}
	@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.aperture-wrap{animation:none}.commit-card,.session-card,.contributor-card{transition:none}}
	@media(max-width:980px){.stats{grid-template-columns:repeat(3,1fr)}.stat:nth-child(3){border-right:0}.controls{grid-template-columns:1fr 1fr 1fr}.tabs{grid-column:1/-1}.controls input{grid-column:1/-1}.count{justify-self:end}.section-head{grid-template-columns:1fr}.section-head p{text-align:left}}
	@media(max-width:720px){body{background-size:24px 24px,24px 24px,auto}.shell{width:min(100% - 24px,1280px);padding-top:18px}.hero{grid-template-columns:1fr;gap:22px;padding-top:24px}.hero h1{font-size:clamp(52px,19vw,86px)}.window{grid-row:2}.aperture-wrap{grid-row:3}.aperture{grid-template-columns:1fr!important}.aperture-week{border-top:5px solid var(--amber);border-left:0}.method-note{grid-template-columns:1fr;gap:8px}.stats{grid-template-columns:1fr 1fr}.stat,.stat.build-week{border-right:1px solid var(--line)}.controls{position:static;grid-template-columns:1fr;margin-bottom:28px}.tabs{grid-column:auto;width:100%}.tab{flex:1}.controls input,.controls select,.count{grid-column:auto;width:100%}.count{justify-self:start;padding:6px 0}.commit-top,.session-heading,.session-group-heading{align-items:flex-start;flex-direction:column}.evidence summary{flex-wrap:wrap}.evidence-grid{grid-template-columns:1fr}.contributor-card{grid-template-columns:1fr 1fr}.contributor-card>div:first-child{grid-column:1/-1}}
	@media(max-width:430px){.shell{width:min(100% - 18px,1280px)}.stats{grid-template-columns:1fr}.stat b{font-size:36px}.section-head h2{font-size:38px}.commit-body,.session-card,.session-group-header,.grouped-commit{padding:17px 15px}.contributor-card{gap:18px;padding:18px 15px}.meta span::before{display:none}.meta{display:grid;grid-template-columns:1fr 1fr}.grouped-commit-heading{align-items:flex-start;flex-direction:column}.session-totals{display:grid;grid-template-columns:1fr 1fr}.aperture>div{align-items:flex-start;flex-direction:column}}

	/* Compact Build Week proofbook. The complete evidence stays available behind native details. */
	.hero{padding-bottom:24px}.hero h1{font-size:clamp(48px,7vw,88px)}.hero p{max-width:700px}.project-facts{display:flex;gap:8px 22px;flex-wrap:wrap;margin-top:18px;color:var(--muted);font:700 10px/1.5 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.project-facts b{color:var(--ink)}
	.usage-headline{display:grid;grid-template-columns:minmax(250px,1.1fr) repeat(3,minmax(150px,.7fr));margin:26px 0 14px;color:#f5ede0;background:var(--ink);box-shadow:7px 7px 0 rgba(42,26,16,.14)}.usage-lead{padding:24px;border-left:10px solid var(--amber)}.usage-lead span{color:#e6c9b4;font:700 10px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}.usage-lead h2{margin:8px 0 5px;color:#fffaf2;font:700 28px/1 Bahnschrift,"Arial Narrow",sans-serif}.usage-lead p{margin:0;color:#dcc7b3;font-size:13px}.headline-metric{display:flex;justify-content:center;flex-direction:column;padding:22px;border-left:1px solid #79543d}.headline-metric b{color:#fffaf2;font:700 clamp(28px,3.6vw,52px)/.9 Bahnschrift,"Arial Narrow",sans-serif}.headline-metric span{margin-top:10px;color:#e6c9b4;font:700 10px/1.35 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.headline-metric small{margin-top:5px;color:#bd9679;font:10px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.other-models{margin:0 0 24px}.other-models>header{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;color:var(--muted);font:700 10px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}.model-card{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(4,auto);gap:10px 16px;align-items:center;padding:12px 14px;background:rgba(245,237,224,.78);border:1px solid var(--line);font:700 10px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.model-card strong{color:var(--verdigris);font-size:12px}.model-card span{color:var(--muted);white-space:nowrap}
	.change-summary{display:grid;grid-template-columns:180px 1fr;gap:18px;padding:18px 0;border-top:1px solid var(--ink);border-bottom:1px solid var(--line)}.change-summary h2{margin:0;font:700 20px/1.1 Bahnschrift,"Arial Narrow",sans-serif;text-transform:uppercase}.change-list{display:flex;gap:7px;flex-wrap:wrap}.change-list span{padding:6px 8px;color:#4d2c18;background:#e4d4ba;border:1px solid var(--line);font:700 10px/1.2 "Cascadia Mono","SFMono-Regular",Consolas,monospace}
	.method-note{display:block;margin:0;padding:12px 0;border-bottom:1px solid var(--line)}.method-note>summary{cursor:pointer;color:var(--muted);font:700 10px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.method-note p{max-width:980px;margin:12px 0 2px;font-size:13px}.controls{display:none!important}
	.work-section{margin-top:34px}.work-heading{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:14px}.work-heading h2{margin:0;font:700 clamp(34px,5vw,60px)/.9 Bahnschrift,"Arial Narrow",sans-serif;letter-spacing:-.04em}.work-heading p{max-width:520px;margin:0;color:var(--muted);text-align:right;font-size:13px}
	.day-group,.archive{margin-bottom:10px;background:rgba(245,237,224,.65);border:1px solid var(--line);box-shadow:3px 3px 0 rgba(42,26,16,.07)}.day-group>summary,.archive>summary{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px 16px;cursor:pointer;list-style:none}.day-group>summary::-webkit-details-marker,.archive>summary::-webkit-details-marker{display:none}.day-group>summary::before,.archive>summary::before{content:"+";flex:0 0 auto;color:var(--amber);font:700 18px/1 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.day-group[open]>summary::before,.archive[open]>summary::before{content:"−"}.day-group>summary strong,.archive>summary strong{margin-right:auto;font:700 17px/1 Bahnschrift,"Arial Narrow",sans-serif}.day-group>summary span,.archive>summary span{color:var(--muted);font:700 10px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-align:right}.session-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:8px;border-top:1px solid var(--line)}
	.build-session{min-width:0;padding:14px 15px;background:var(--paper-high);border:1px solid var(--line);border-left:6px solid var(--verdigris)}.build-session.build-week{border-left-color:var(--amber)}.build-session>header{display:flex;justify-content:space-between;gap:12px;align-items:center;color:var(--muted);font:700 10px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.build-session>header>div{display:flex;gap:6px 12px;align-items:center;flex-wrap:wrap}.build-session>header strong{color:#633800;background:var(--amber-soft);padding:4px 6px;text-transform:uppercase}.model{color:var(--verdigris)}.session-id{display:block;margin:9px 0 8px;color:#6b4c36;font:10px/1.35 "Cascadia Mono","SFMono-Regular",Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-metrics{display:flex;gap:8px 18px;flex-wrap:wrap;padding-bottom:9px;border-bottom:1px solid var(--line);color:var(--muted);font:700 9px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.session-metrics b{color:var(--ink);font-size:12px}
	.commit-branches{display:grid;gap:3px;margin:9px 0 0;padding:0;list-style:none}.commit-branch{display:grid;grid-template-columns:14px 58px minmax(0,1fr) auto;gap:5px;align-items:baseline;min-width:0;color:var(--muted);font:10px/1.35 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.branch-mark{color:var(--line)}.sha{font-weight:800}.commit-subject{overflow:hidden;color:#4d2c18;text-overflow:ellipsis;white-space:nowrap}.week-mark{padding:1px 3px;color:#633800;background:var(--amber-soft);font-size:8px;font-weight:800}.more-commits,.session-proof{margin-top:7px}.more-commits>summary,.session-proof>summary,.commit-proof>summary{cursor:pointer;color:var(--muted);font:700 9px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.session-proof{padding-top:7px;border-top:1px dotted var(--line)}.proof-body{padding-top:8px}.usage-detail,.tool-detail{display:flex;gap:5px 12px;flex-wrap:wrap;margin-bottom:7px;color:var(--muted);font:9px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.validation-detail{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}.validation-detail strong{font:700 9px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.validation-detail code,.tool-detail span{padding:3px 5px;background:var(--paper-low)}.commit-proof{margin-top:6px}.proof-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}.proof-grid label{display:block;margin-bottom:3px;color:var(--muted);font:700 8px/1.3 "Cascadia Mono","SFMono-Regular",Consolas,monospace;text-transform:uppercase}.proof-grid pre{padding:8px;font-size:9px}.integrity{display:grid;grid-template-columns:70px minmax(0,1fr);gap:4px 8px;margin-top:8px;padding-top:7px;border-top:1px dotted var(--line)}.integrity dt,.integrity dd{margin:0;font:9px/1.35 "Cascadia Mono","SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.integrity dt{color:var(--muted)}
	.archive{margin-top:14px}.archive .session-grid{background:rgba(228,212,186,.35)}.compact-history{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 20px;margin:0;padding:12px 16px 16px;border-top:1px solid var(--line);list-style:none}.compact-history .commit-branch{grid-template-columns:14px 58px minmax(0,1fr) auto}
	.contributors{margin-top:30px;padding-top:16px;border-top:3px solid var(--ink)}.contributors h2{margin:0 0 8px;font:700 22px/1 Bahnschrift,"Arial Narrow",sans-serif}.contributor-row{display:flex;justify-content:space-between;gap:18px;padding:10px 0;border-top:1px solid var(--line);font:700 10px/1.4 "Cascadia Mono","SFMono-Regular",Consolas,monospace}.contributor-row div{display:grid}.contributor-row div span,.contributor-row>span{color:var(--muted)}
	@media(max-width:900px){.usage-headline{grid-template-columns:1fr 1fr}.usage-lead{grid-column:1/-1}.headline-metric{border-top:1px solid #79543d}.headline-metric:nth-child(4){grid-column:1/-1}.model-card{grid-template-columns:1fr 1fr}.model-card strong{grid-column:1/-1}.session-grid,.compact-history{grid-template-columns:1fr}.work-heading,.change-summary{display:grid;grid-template-columns:1fr}.work-heading p{text-align:left}.day-group>summary,.archive>summary{align-items:flex-start}.day-group>summary span,.archive>summary span{text-align:left}}
	@media(max-width:520px){.shell{width:min(100% - 18px,1280px)}.hero{padding-top:18px}.hero h1{font-size:clamp(45px,16vw,72px)}.usage-headline{grid-template-columns:1fr}.usage-lead,.headline-metric{grid-column:auto}.headline-metric{padding:17px 20px}.headline-metric b{font-size:38px}.other-models>header,.day-group>summary,.archive>summary,.contributor-row{align-items:flex-start;flex-direction:column}.day-group>summary::before,.archive>summary::before{position:absolute}.day-group>summary,.archive>summary{position:relative;padding-left:38px}.session-grid{padding:6px}.commit-branch{grid-template-columns:12px 54px minmax(0,1fr) auto}.project-facts{display:grid;grid-template-columns:1fr 1fr}.proof-grid{grid-template-columns:1fr}}
	</style></head><body><main class="shell">
	<header class="hero"><div class="hero-copy"><div class="kicker">OpenAI Build Week · construction provenance</div><h1>${escapeHtml(report.title)}</h1><p>A compact view of what Codex and Hlid built together, with commits branching from the exact agent sessions that produced them.</p><div class="project-facts"><span><b>${formatNumber(report.commits.length)}</b> total commits</span><span><b>${formatNumber(preEventCommits)}</b> pre-event</span><span><b>${formatNumber(buildWeekCommits.length)}</b> Build Week</span><span><b>${formatNumber(groupedCommitShas.size)}</b> directly linked</span><span><b>${formatNumber(signedCommits.length)}</b> signed</span></div></div><div class="window"><strong>${escapeHtml(report.repository.name)}</strong><div>Baseline ${escapeHtml(report.repository.baseline.slice(0, 12))}</div><div>Head ${escapeHtml(report.repository.head.slice(0, 12))}</div><div>Observed ${escapeHtml(displayDate(report.generatedAt))}</div></div></header>
	<section class="usage-headline"><div class="usage-lead"><span>Official Build Week window</span><h2>GPT-5.6 build total</h2><p>All project-scoped GPT-5.6 sessions during the eligibility window. Cached input is included in reported tokens.</p></div><div class="headline-metric"><b>${formatNumber(gpt56BuildWeekSessions.length)}</b><span>Sessions</span></div><div class="headline-metric"><b title="${formatNumber(buildWeekTokens)}">${formatCompactNumber(buildWeekTokens)}</b><span>Reported tokens</span><small>${formatNumber(buildWeekTokens)} exact</small></div><div class="headline-metric"><b>${formatNumber(buildWeekToolCalls)}</b><span>Tool calls</span></div></section>
	${otherLinkedModels.length ? `<section class="other-models"><header><strong>Other models with direct commit evidence</strong><span>Only models attached to project commits are shown</span></header><div class="model-grid">${otherLinkedModels.map(linkedModelCard).join("")}</div></section>` : ""}
	<section class="change-summary"><h2>What changed</h2><div class="change-list"><span>Windows Computer Use</span><span>Provider-history recovery</span><span>Cross-provider session controls</span><span>Long-session performance</span><span>Managed CLIProxy routing</span><span>Local read-aloud</span><span>Obsidian CLI tools</span><span>Build provenance</span></div></section>
	<details class="method-note"><summary>Proof standard and accounting notes</summary><p>Build Week records fall inside July 13, 9:00 AM PDT through July 21, 5:00 PM PDT. A direct link means the commit SHA was captured from a <code>git commit</code> tool call in that exact agent transcript. Session token and tool totals appear once, on the owning session. Timestamp-only guesses are not presented as proof.</p></details>
	<section class="work-section"><div class="work-heading"><h2>What the sessions shipped</h2><p>Build Week sessions are grouped by commit day. The busiest day is open; every other day is one click away. Commits stay as tiny branches of their owning session.</p></div>${buildWeekDayGroups.join("")}</section>
	${earlierLinkedSessions.length ? `<details class="archive"><summary><strong>Earlier directly linked sessions</strong><span>${formatNumber(earlierLinkedSessions.length)} sessions · ${formatNumber(earlierLinkedSessions.reduce((sum, session) => sum + (commitsBySession.get(session.threadId)?.length ?? 0), 0))} earlier linked commits</span></summary><div class="session-grid">${sessionCollection(earlierLinkedSessions, commitsBySession)}</div></details>` : ""}
	${unlinkedCommits.length ? `<details class="archive"><summary><strong>Other project history</strong><span>${formatNumber(unlinkedCommits.length)} commits without direct transcript capture</span></summary><ul class="compact-history">${unlinkedCommits.map(compactCommit).join("")}</ul></details>` : ""}
	<section class="contributors"><h2>Contributors</h2>${report.contributors.map(contributorRow).join("")}</section>
<div class="footer">Raw prompts, developer instructions, arbitrary tool output, and environment data are excluded. Transcript fingerprints remain available for private verification. Regenerate this snapshot as the project evolves.</div>
</main></body></html>`;
}
