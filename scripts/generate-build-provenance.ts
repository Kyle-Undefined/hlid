import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import {
	extractClaudeBuildSessionProvenance,
	extractBuildSessionProvenance,
	renderBuildProvenanceHtml,
	type BuildCommitProvenance,
	type BuildContributor,
	type BuildProvenanceReport,
	type BuildSessionProvenance,
} from "../src/lib/buildProvenance";
import {
	discoverClaudeHistoryRoots,
	planProviderHistoryImport,
	type ProviderHistorySession,
} from "../src/db/providerHistoryImport";
import { readJsonlObjects } from "../src/db/jsonl";
import { initializeSchema } from "../src/db/schema";

const DEFAULT_SINCE = "2026-07-13T16:00:00.000Z";
const DEFAULT_UNTIL = "2026-07-22T00:00:00.000Z";

function usage(message?: string): never {
	if (message) console.error(message);
	console.error(
		[
			"Usage:",
			"  bun scripts/generate-build-provenance.ts [options]",
			"",
			"Options:",
			"  --repo <path>          Git repository (default: current directory)",
			"  --codex-root <path>    Codex session/archive root; repeatable",
			"  --claude-root <path>   Claude project-history root; repeatable",
			"  --since <ISO date>     Build Week highlight start",
			"  --until <ISO date>     Build Week highlight end",
			"  --baseline <revision>  Pre-window baseline commit (auto-detected)",
			"  --output <path>        HTML output path",
			"  --title <text>         Report title",
			"  --help                 Show this help",
		].join("\n"),
	);
	process.exit(1);
}

type Options = {
	repo: string;
	roots: string[];
	claudeRoots: string[] | null;
	since: string;
	until: string;
	baseline: string | null;
	output: string;
	title: string;
};

function parseDate(value: string, flag: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) usage(`${flag} must be a valid ISO date`);
	return new Date(timestamp).toISOString();
}

function parseArgs(argv: string[]): Options {
	if (argv.includes("--help")) usage();
	const values = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (!flag?.startsWith("--")) usage(`Unexpected argument: ${flag}`);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
		values.set(flag, [...(values.get(flag) ?? []), value]);
		index++;
	}
	const allowed = new Set([
		"--repo",
		"--codex-root",
		"--claude-root",
		"--since",
		"--until",
		"--baseline",
		"--output",
		"--title",
	]);
	for (const flag of values.keys()) {
		if (!allowed.has(flag)) usage(`Unknown option: ${flag}`);
	}
	const repo = resolve(values.get("--repo")?.at(-1) ?? process.cwd());
	const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
	const roots = values.get("--codex-root")?.map((value) => resolve(value)) ?? [
		join(codexHome, "sessions"),
		join(codexHome, "archived_sessions"),
	];
	return {
		repo,
		roots,
		claudeRoots:
			values.get("--claude-root")?.map((value) => resolve(value)) ?? null,
		since: parseDate(values.get("--since")?.at(-1) ?? DEFAULT_SINCE, "--since"),
		until: parseDate(values.get("--until")?.at(-1) ?? DEFAULT_UNTIL, "--until"),
		baseline: values.get("--baseline")?.at(-1) ?? null,
		output: resolve(
			values.get("--output")?.at(-1) ??
				join(repo, "openai-build-week-provenance.html"),
		),
		title: values.get("--title")?.at(-1) ?? "Hlið built with Hlið",
	};
}

function git(repo: string, args: string[], allowFailure = false): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0 && !allowFailure) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
		);
	}
	return result.stdout.toString().trim();
}

function repositoryUrl(remote: string): string | null {
	const value = remote.trim().replace(/\.git$/, "");
	if (/^https?:\/\//.test(value)) return value;
	const ssh = value.match(/^git@([^:]+):(.+)$/);
	return ssh ? `https://${ssh[1]}/${ssh[2]}` : null;
}

function numericStats(repo: string, sha: string): {
	additions: number;
	deletions: number;
	filesChanged: number;
} {
	let additions = 0;
	let deletions = 0;
	let filesChanged = 0;
	for (const line of git(repo, ["show", "--root", "--numstat", "--format=", sha]).split(
		"\n",
	)) {
		if (!line.trim()) continue;
		const [added, deleted] = line.split("\t");
		filesChanged++;
		if (/^\d+$/.test(added ?? "")) additions += Number(added);
		if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
	}
	return { additions, deletions, filesChanged };
}

function coAuthors(message: string): { name: string; email: string }[] {
	const result = new Map<string, { name: string; email: string }>();
	for (const match of message.matchAll(
		/^Co-Authored-By:\s*(.+?)\s*<([^>]+)>\s*$/gim,
	)) {
		const name = match[1]?.trim();
		const email = match[2]?.trim();
		if (!name || !email) continue;
		result.set(email.toLocaleLowerCase(), { name, email });
	}
	return [...result.values()];
}

function loadCommits(
	repo: string,
	since: string,
	until: string,
	url: string | null,
): BuildCommitProvenance[] {
	const format = [
		"%H",
		"%h",
		"%aI",
		"%cI",
		"%aN",
		"%aE",
		"%G?",
		"%GF",
		"%s",
		"%B",
	].join("%x1f");
	const output = git(repo, [
		"log",
		"--reverse",
		`--format=${format}%x1e`,
	]);
	return output
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [
				sha,
				shortSha,
				authorDate,
				commitDate,
				authorName,
				authorEmail,
				signatureStatus,
				signer,
				subject,
				...message
			] = record.split("\x1f");
			if (!sha || !shortSha || !authorDate || !commitDate) {
				throw new Error("Unexpected git log record while generating provenance");
			}
			return {
				sha,
				shortSha,
				subject: subject ?? "",
				authorDate,
				commitDate,
				authorName: authorName || "Unknown contributor",
				authorEmail: authorEmail || "",
				coAuthors: coAuthors(message.join("\x1f")),
				signatureStatus: signatureStatus ?? "",
				signerFingerprint: signer ?? "",
				...numericStats(repo, sha),
				url: url ? `${url}/commit/${sha}` : null,
				sessionIds: [],
				inBuildWeek:
					Date.parse(commitDate) >= Date.parse(since) &&
					Date.parse(commitDate) <= Date.parse(until),
			};
		});
}

function likelyWindowPath(path: string, since: number, until: number): boolean {
	const name = basename(path);
	const match = name.match(/rollout-(\d{4}-\d{2}-\d{2})T/);
	if (!match?.[1]) return true;
	const day = Date.parse(`${match[1]}T00:00:00.000Z`);
	const padding = 24 * 60 * 60 * 1_000;
	return day >= since - padding && day <= until + padding;
}

async function rolloutPaths(roots: string[], since: number, until: number) {
	const paths: string[] = [];
	for (const root of roots) {
		if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
		for await (const path of new Bun.Glob("**/rollout-*.jsonl").scan({
			cwd: root,
			absolute: true,
			onlyFiles: true,
		})) {
			if (likelyWindowPath(path, since, until)) paths.push(path);
		}
	}
	return paths.sort();
}

async function gitCommonDirectory(path: string): Promise<string | null> {
	const common = git(path, ["rev-parse", "--git-common-dir"], true);
	if (!common) return null;
	const absolute = resolve(path, common);
	return realpath(absolute).catch(() => absolute);
}

async function cwdMatchesRepository(
	cwd: string,
	repo: string,
	repositoryCommonDirectory: string | null,
): Promise<boolean> {
	if (!cwd) return false;
	const normalized = resolve(cwd);
	if (normalized === repo || normalized.startsWith(`${repo}${sep}`)) return true;
	if (!(await stat(normalized).catch(() => null))?.isDirectory()) return false;
	const common = await gitCommonDirectory(normalized);
	return Boolean(common && repositoryCommonDirectory && common === repositoryCommonDirectory);
}

async function loadCodexSessions(
	options: Options,
	projectSince: string,
	projectUntil: string,
): Promise<BuildSessionProvenance[]> {
	const since = Date.parse(projectSince);
	const until = Date.parse(projectUntil);
	const buildWeekSince = Date.parse(options.since);
	const buildWeekUntil = Date.parse(options.until);
	const repositoryCommonDirectory = await gitCommonDirectory(options.repo);
	const paths = await rolloutPaths(options.roots, since, until);
	const sessions = new Map<string, BuildSessionProvenance>();
	for (const path of paths) {
		const { records, text } = await readJsonlObjects(path);
		const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
		const session = extractBuildSessionProvenance({
			records,
			transcriptPath: basename(path),
			transcriptSha256: hash,
		});
		if (
			!session ||
			!(await cwdMatchesRepository(
				session.cwd,
				options.repo,
				repositoryCommonDirectory,
			))
		)
			continue;
		session.cwd = basename(options.repo);
		const started = Date.parse(session.startedAt);
		const ended = Date.parse(session.endedAt || session.startedAt);
		if (started > until || ended < since) continue;
		session.inBuildWeek = started <= buildWeekUntil && ended >= buildWeekSince;
		const existing = sessions.get(session.threadId);
		if (
			!existing ||
			session.endedAt > existing.endedAt ||
			session.usage.totalTokens > existing.usage.totalTokens
		) {
			sessions.set(session.threadId, session);
		}
	}
	return [...sessions.values()].sort((a, b) =>
		a.startedAt.localeCompare(b.startedAt),
	);
}

function claudeUsage(session: ProviderHistorySession) {
	let inputTokens = 0;
	let cachedInputTokens = 0;
	let outputTokens = 0;
	for (const query of session.queries) {
		const cached =
			query.usage.cacheReadTokens + query.usage.cacheCreationTokens;
		inputTokens += query.usage.inputTokens + cached;
		cachedInputTokens += cached;
		outputTokens += query.usage.outputTokens;
	}
	return {
		inputTokens,
		cachedInputTokens,
		outputTokens,
		reasoningOutputTokens: 0,
		totalTokens: inputTokens + outputTokens,
	};
}

function claudeOriginator(sourceSurface: string): string {
	if (sourceSurface === "claude-desktop-cowork") return "Claude Desktop";
	if (sourceSurface === "claude-sdk") return "Claude SDK";
	return "Claude CLI";
}

async function loadClaudeSessions(
	options: Options,
	projectSince: string,
	projectUntil: string,
): Promise<BuildSessionProvenance[]> {
	const claudeRoots =
		options.claudeRoots ?? (await discoverClaudeHistoryRoots());
	if (claudeRoots.length === 0) return [];
	const db = new Database(":memory:");
	initializeSchema(db);
	const manifest = await planProviderHistoryImport({ db, claudeRoots });
	db.close();
	const since = Date.parse(projectSince);
	const until = Date.parse(projectUntil);
	const buildWeekSince = Date.parse(options.since);
	const buildWeekUntil = Date.parse(options.until);
	const repositoryCommonDirectory = await gitCommonDirectory(options.repo);
	const sessions: BuildSessionProvenance[] = [];
	for (const planned of manifest.sessions) {
		if (planned.providerId !== "claude" || !planned.cwd) continue;
		const started = planned.startedAt * 1_000;
		const ended = planned.endedAt * 1_000;
		if (started > until || ended < since) continue;
		if (
			!(await cwdMatchesRepository(
				planned.cwd,
				options.repo,
				repositoryCommonDirectory,
			))
		) {
			continue;
		}
		const transcriptRecords = await Promise.all(
			planned.transcriptFiles.map(async (file) =>
				(await readJsonlObjects(file.path)).records,
			),
		);
		const mainTranscript = planned.transcriptFiles.find(
			(file) => file.subpath === "",
		);
		const session = extractClaudeBuildSessionProvenance({
			threadId: planned.nativeSessionId,
			startedAt: new Date(started).toISOString(),
			endedAt: new Date(ended).toISOString(),
			cwd: basename(options.repo),
			originator: claudeOriginator(planned.sourceSurface),
			models: planned.queries
				.map((query) => query.model)
				.filter((model): model is string => Boolean(model)),
			usage: claudeUsage(planned),
			records: transcriptRecords.flat(),
			assistantMessageIds: planned.queries.flatMap(
				(query) => query.evidence.callIds,
			),
			transcriptPath: `${basename(mainTranscript?.path ?? planned.resumePath)}${planned.transcriptFiles.length > 1 ? ` (+${planned.transcriptFiles.length - 1} subagent transcript${planned.transcriptFiles.length === 2 ? "" : "s"})` : ""}`,
			transcriptSha256: planned.sourceHash,
		});
		session.inBuildWeek = started <= buildWeekUntil && ended >= buildWeekSince;
		sessions.push(session);
	}
	return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function contributorDisplayName(name: string, email: string): string {
	return email.toLocaleLowerCase().endsWith("@anthropic.com")
		? "Claude (Anthropic)"
		: name;
}

function contributors(
	commits: BuildCommitProvenance[],
	sessions: BuildSessionProvenance[],
): BuildContributor[] {
	const totals = new Map<string, BuildContributor>();
	for (const commit of commits) {
		const credits = [
			{
				name: commit.authorName,
				email: commit.authorEmail,
				role: "primary" as const,
			},
			...commit.coAuthors.map((coAuthor) => ({
				...coAuthor,
				role: "coauthor" as const,
			})),
		];
		const credited = new Set<string>();
		for (const credit of credits) {
			const key =
				credit.email.toLocaleLowerCase() || credit.name.toLocaleLowerCase();
			if (credited.has(key)) continue;
			credited.add(key);
			const contributor = totals.get(key) ?? {
				name: contributorDisplayName(credit.name, credit.email),
				email: credit.email,
				aliases: [],
				commits: 0,
				buildWeekCommits: 0,
				primaryCommits: 0,
				coauthoredCommits: 0,
				sessionLinkedCommits: 0,
				buildWeekSessionLinkedCommits: 0,
			};
			if (
				credit.name !== contributor.name &&
				!contributor.aliases.includes(credit.name)
			) {
				contributor.aliases.push(credit.name);
			}
			contributor.commits++;
			if (commit.inBuildWeek) contributor.buildWeekCommits++;
			if (credit.role === "primary") contributor.primaryCommits++;
			else contributor.coauthoredCommits++;
			totals.set(key, contributor);
		}
	}
	const claudeSessionIds = new Set(
		sessions
			.filter((session) =>
				session.originator.toLocaleLowerCase().startsWith("claude"),
			)
			.map((session) => session.threadId),
	);
	for (const contributor of totals.values()) {
		if (!contributor.email.toLocaleLowerCase().endsWith("@anthropic.com")) {
			continue;
		}
		const linked = commits.filter((commit) =>
			commit.sessionIds.some((sessionId) => claudeSessionIds.has(sessionId)),
		);
		contributor.sessionLinkedCommits = linked.length;
		contributor.buildWeekSessionLinkedCommits = linked.filter(
			(commit) => commit.inBuildWeek,
		).length;
	}
	return [...totals.values()].sort(
		(a, b) => b.commits - a.commits || a.name.localeCompare(b.name),
	);
}

function correlate(
	sessions: BuildSessionProvenance[],
	commits: BuildCommitProvenance[],
): void {
	for (const session of sessions) {
		for (const evidence of session.commitEvidence) {
			const matches = commits.filter((commit) => commit.sha.startsWith(evidence.sha));
			if (matches.length !== 1) continue;
			const commit = matches[0];
			if (!commit) continue;
			if (!commit.sessionIds.includes(session.threadId)) {
				commit.sessionIds.push(session.threadId);
			}
			evidence.sha = commit.sha;
		}
	}
}

const options = parseArgs(process.argv.slice(2));
const repo = await realpath(options.repo).catch(() => options.repo);
options.repo = repo;
const repositoryRemote = git(repo, ["remote", "get-url", "origin"], true);
const url = repositoryUrl(repositoryRemote);
const baseline = git(repo, [
	"rev-parse",
	options.baseline ?? git(repo, ["rev-list", "-1", `--before=${options.since}`, "HEAD"]),
]);
const head = git(repo, ["rev-parse", "HEAD"]);
const commits = loadCommits(repo, options.since, options.until, url);
const projectSince = commits[0]?.commitDate ?? options.since;
const observedThrough = new Date().toISOString();
const [codexSessions, claudeSessions] = await Promise.all([
	loadCodexSessions(options, projectSince, observedThrough),
	loadClaudeSessions(options, projectSince, observedThrough),
]);
const sessions = [...codexSessions, ...claudeSessions].sort((a, b) =>
	a.startedAt.localeCompare(b.startedAt),
);
correlate(sessions, commits);

const report: BuildProvenanceReport = {
	title: options.title,
	generatedAt: new Date().toISOString(),
	repository: {
		name: basename(repo),
		path: basename(repo),
		url,
		baseline,
		head,
	},
	window: { since: options.since, until: options.until },
	sessions,
	commits,
	contributors: contributors(commits, sessions),
};

await mkdir(dirname(options.output), { recursive: true });
await Bun.write(options.output, renderBuildProvenanceHtml(report));
console.log(
	JSON.stringify(
		{
			output: options.output,
			baseline,
			head,
			sessions: sessions.length,
			codexSessions: codexSessions.length,
			claudeSessions: claudeSessions.length,
			commits: commits.length,
			buildWeekCommits: commits.filter((commit) => commit.inBuildWeek).length,
			contributors: report.contributors.length,
			linkedCommits: commits.filter((commit) => commit.sessionIds.length > 0).length,
		},
		null,
		2,
	),
);
