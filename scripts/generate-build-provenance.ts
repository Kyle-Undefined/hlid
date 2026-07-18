import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	extractBuildSessionProvenance,
	renderBuildProvenanceHtml,
	type BuildCommitProvenance,
	type BuildProvenanceReport,
	type BuildSessionProvenance,
} from "../src/lib/buildProvenance";
import { readJsonlObjects } from "../src/db/jsonl";

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
			"  --since <ISO date>     Evidence window start",
			"  --until <ISO date>     Evidence window end",
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
		since: parseDate(values.get("--since")?.at(-1) ?? DEFAULT_SINCE, "--since"),
		until: parseDate(values.get("--until")?.at(-1) ?? DEFAULT_UNTIL, "--until"),
		baseline: values.get("--baseline")?.at(-1) ?? null,
		output: resolve(
			values.get("--output")?.at(-1) ??
				join(repo, "reports", "openai-build-week-provenance.html"),
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
	for (const line of git(repo, ["show", "--numstat", "--format=", sha]).split("\n")) {
		if (!line.trim()) continue;
		const [added, deleted] = line.split("\t");
		filesChanged++;
		if (/^\d+$/.test(added ?? "")) additions += Number(added);
		if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
	}
	return { additions, deletions, filesChanged };
}

function loadCommits(
	repo: string,
	since: string,
	until: string,
	url: string | null,
): BuildCommitProvenance[] {
	const format = ["%H", "%h", "%aI", "%cI", "%G?", "%GF", "%s"].join("%x1f");
	const output = git(repo, [
		"log",
		`--since=${since}`,
		`--until=${until}`,
		"--reverse",
		`--format=${format}%x1e`,
	]);
	return output
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [sha, shortSha, authorDate, commitDate, signatureStatus, signer, ...subject] =
				record.split("\x1f");
			if (!sha || !shortSha || !authorDate || !commitDate) {
				throw new Error("Unexpected git log record while generating provenance");
			}
			return {
				sha,
				shortSha,
				subject: subject.join("\x1f"),
				authorDate,
				commitDate,
				signatureStatus: signatureStatus ?? "",
				signerFingerprint: signer ?? "",
				...numericStats(repo, sha),
				url: url ? `${url}/commit/${sha}` : null,
				sessionIds: [],
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

function cwdMatchesRepository(cwd: string, repo: string): boolean {
	if (!cwd) return false;
	const normalized = resolve(cwd);
	return normalized === repo || normalized.startsWith(`${repo}${sep}`);
}

async function loadSessions(options: Options): Promise<BuildSessionProvenance[]> {
	const since = Date.parse(options.since);
	const until = Date.parse(options.until);
	const paths = await rolloutPaths(options.roots, since, until);
	const sessions: BuildSessionProvenance[] = [];
	for (const path of paths) {
		const { records, text } = await readJsonlObjects(path);
		const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
		const session = extractBuildSessionProvenance({
			records,
			transcriptPath: basename(path),
			transcriptSha256: hash,
		});
		if (!session || !cwdMatchesRepository(session.cwd, options.repo)) continue;
		session.cwd = basename(options.repo);
		const started = Date.parse(session.startedAt);
		const ended = Date.parse(session.endedAt || session.startedAt);
		if (started > until || ended < since) continue;
		sessions.push(session);
	}
	return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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
const sessions = await loadSessions(options);
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
			commits: commits.length,
			linkedCommits: commits.filter((commit) => commit.sessionIds.length > 0).length,
		},
		null,
		2,
	),
);
