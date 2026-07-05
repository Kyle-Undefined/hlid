// Vendors a curated slice of codex-cli's app-server JSON-RPC types.
//
// codex-cli ships its own generator (`codex app-server generate-ts`) that
// emits ts-rs bindings for its entire protocol — hundreds of files, one type
// per file, relative imports, protocol-v2 types under a v2/ subdir. hlid only
// needs a handful of the outbound param/response shapes it builds or parses
// in src/server/codexProvider.ts, so this script:
//
//   1. Runs the installed CLI's generator into a scratch tmpdir.
//   2. Walks the import graph from a curated seed list so the copied set is
//      self-contained (every relative import a seed file needs, transitively).
//   3. Copies that closure into src/server/codexProtocol/, preserving the
//      generator's own directory layout (so relative imports need no rewrite),
//      with a vendoring banner prepended to each file.
//   4. Writes an index.ts barrel re-exporting the seed types.
//
// Idempotent: wipes and rewrites src/server/codexProtocol/ on every run.
// Pinned to a CLI version deliberately — re-run this manually after a codex
// upgrade, review the diff, then bump the pin below.
//
// Usage: bun scripts/generate-codex-types.ts

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

const CLI_VERSION_PIN = "0.142.4";

const root = join(import.meta.dir, "..");
const outDir = join(root, "src", "server", "codexProtocol");

// name -> path relative to the generator's --out dir.
const SEEDS: Array<[name: string, relPath: string]> = [
	["ThreadStartParams", "v2/ThreadStartParams.ts"],
	["ThreadResumeParams", "v2/ThreadResumeParams.ts"],
	["TurnStartParams", "v2/TurnStartParams.ts"],
	["SandboxPolicy", "v2/SandboxPolicy.ts"],
	["SandboxMode", "v2/SandboxMode.ts"],
	["AskForApproval", "v2/AskForApproval.ts"],
	["Model", "v2/Model.ts"],
	["ModelListParams", "v2/ModelListParams.ts"],
	["ModelListResponse", "v2/ModelListResponse.ts"],
	[
		"CommandExecutionRequestApprovalParams",
		"v2/CommandExecutionRequestApprovalParams.ts",
	],
	[
		"CommandExecutionRequestApprovalResponse",
		"v2/CommandExecutionRequestApprovalResponse.ts",
	],
	["CommandExecutionApprovalDecision", "v2/CommandExecutionApprovalDecision.ts"],
	[
		"FileChangeRequestApprovalParams",
		"v2/FileChangeRequestApprovalParams.ts",
	],
	[
		"FileChangeRequestApprovalResponse",
		"v2/FileChangeRequestApprovalResponse.ts",
	],
	[
		"PermissionsRequestApprovalParams",
		"v2/PermissionsRequestApprovalParams.ts",
	],
	[
		"PermissionsRequestApprovalResponse",
		"v2/PermissionsRequestApprovalResponse.ts",
	],
	// Not top-level RPC payloads themselves, but referenced directly by
	// codexProvider.ts when typing model/list parsing and approval results —
	// barrel-exporting them saves a deep import path at the call site.
	["ReasoningEffortOption", "v2/ReasoningEffortOption.ts"],
	["GrantedPermissionProfile", "v2/GrantedPermissionProfile.ts"],
];

async function run(cmd: string[], opts?: { cwd?: string }): Promise<string> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		throw new Error(
			`failed to spawn \`${cmd.join(" ")}\`: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(
			`\`${cmd.join(" ")}\` exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
		);
	}
	return stdout;
}

/** Resolves a relative import from `fromRel`'s directory, adding `.ts`. */
function resolveImport(fromRel: string, importPath: string): string {
	const fromDir = dirname(fromRel);
	let resolved = normalize(join(fromDir, importPath));
	if (!resolved.endsWith(".ts")) resolved += ".ts";
	return resolved;
}

/** Walks the ts-rs `import type { X } from "./Y"` graph from a seed list. */
async function walkClosure(
	genRoot: string,
	seeds: string[],
): Promise<Set<string>> {
	const visited = new Set<string>();
	const queue = [...seeds];
	const importRe = /import type \{[^}]+\} from "([^"]+)";/g;

	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: queue.length checked above
		const rel = queue.pop()!;
		if (visited.has(rel)) continue;
		visited.add(rel);

		const abs = join(genRoot, rel);
		if (!existsSync(abs)) {
			throw new Error(
				`generated file missing: ${rel} (codex-cli's generate-ts output may have changed shape — update the seed list)`,
			);
		}
		const content = await readFile(abs, "utf8");
		for (const match of content.matchAll(importRe)) {
			const resolved = resolveImport(rel, match[1] ?? "");
			if (!visited.has(resolved)) queue.push(resolved);
		}
	}
	return visited;
}

function banner(cliVersion: string): string {
	const date = new Date().toISOString().slice(0, 10);
	return `// AUTO-GENERATED — vendored from codex-cli's \`codex app-server generate-ts\`.
// CLI version: ${cliVersion} (pinned to ${CLI_VERSION_PIN} in scripts/generate-codex-types.ts)
// Generated: ${date}
// Regenerate via \`bun scripts/generate-codex-types.ts\`; version bumps are
// deliberate manual updates, not run automatically on every build.

`;
}

async function main(): Promise<void> {
	if (!existsSync(join(root, "package.json"))) {
		throw new Error(`unexpected root: ${root}`);
	}

	console.log("Checking codex CLI...");
	const versionOut = await run(["codex", "--version"]).catch((err) => {
		throw new Error(
			`codex CLI not found on PATH (required to vendor app-server types): ${err instanceof Error ? err.message : String(err)}`,
		);
	});
	const cliVersion = versionOut.trim();
	if (!cliVersion.includes(CLI_VERSION_PIN)) {
		console.warn(
			`warning: installed codex CLI reports "${cliVersion}", pinned version is ${CLI_VERSION_PIN}. ` +
				"Generated types may drift from the pin — review the diff carefully and bump CLI_VERSION_PIN once done.",
		);
	}

	const genRoot = mkdtempSync(join(tmpdir(), "codex-app-server-ts-"));
	try {
		console.log(`Running \`codex app-server generate-ts --out ${genRoot}\`...`);
		await run(["codex", "app-server", "generate-ts", "--out", genRoot]);

		console.log("Walking import graph from seed types...");
		const closure = await walkClosure(
			genRoot,
			SEEDS.map(([, relPath]) => relPath),
		);
		console.log(`Vendoring ${closure.size} files...`);

		rmSync(outDir, { recursive: true, force: true });
		await mkdir(outDir, { recursive: true });

		const b = banner(cliVersion);
		for (const rel of closure) {
			const content = await readFile(join(genRoot, rel), "utf8");
			const dest = join(outDir, rel);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, b + content);
		}

		const barrelLines = SEEDS.map(([name, relPath]) => {
			const importPath = `./${relPath.replace(/\.ts$/, "")}`;
			return `export type { ${name} } from "${importPath}";`;
		});
		await writeFile(
			join(outDir, "index.ts"),
			`${b}${barrelLines.join("\n")}\n`,
		);

		console.log(
			`Wrote ${closure.size} files + index.ts to src/server/codexProtocol/ (${cliVersion}).`,
		);
	} finally {
		await rm(genRoot, { recursive: true, force: true });
	}
}

await main();
