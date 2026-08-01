import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import * as db from "../db";
import { HLID_CREATE_VISUALIZATION_TOOL } from "../lib/hlidContext";
import { pathStartsWith } from "../lib/paths";
import {
	artifactDirectory,
	artifactPath,
	artifactsDirectory,
	prepareLibrary,
	storageKey,
} from "./libraryStore";

const VISUALIZATION_TOOL_NAMES = new Set([
	HLID_CREATE_VISUALIZATION_TOOL,
	`hlid.${HLID_CREATE_VISUALIZATION_TOOL}`,
	`mcp__hlid__${HLID_CREATE_VISUALIZATION_TOOL}`,
]);

type VisualizationToolResult = Record<string, unknown> & {
	type: "hlid_visualization";
	attachment_id: string;
	filename: string;
};

type VisualizationReference = {
	toolId: string;
	result: VisualizationToolResult;
	originalResult: string;
};

type CreatedVisualizationCopy = {
	id: string;
	path: string;
	directory: string;
};

function parseVisualizationToolResult(
	resultText: string | null,
): VisualizationToolResult | null {
	if (!resultText) return null;
	let value: unknown;
	try {
		value = JSON.parse(resultText);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	if (
		result.type !== "hlid_visualization" ||
		typeof result.attachment_id !== "string" ||
		!result.attachment_id ||
		typeof result.filename !== "string" ||
		!result.filename
	) {
		return null;
	}
	return result as VisualizationToolResult;
}

async function removeCreatedCopies(
	created: readonly CreatedVisualizationCopy[],
): Promise<void> {
	for (const copy of [...created].reverse()) {
		await db.deleteAttachment(copy.id).catch(() => null);
		await unlink(copy.path).catch(() => {});
		await rmdir(copy.directory).catch(() => {});
	}
}

/**
 * Give a fork independent ownership of each session-retained visualization its
 * copied tool events reference. The copied tool result is rewritten to the new
 * attachment id, so deleting or aging out the source session cannot break the
 * fork's inline iframe.
 */
export async function copyForkedVisualizationAttachments(
	sourceSessionId: string,
	targetSessionId: string,
): Promise<number> {
	const references: VisualizationReference[] = [];
	for (const event of await db.getSessionToolEventSummaries(targetSessionId)) {
		if (event.is_error === 1 || !VISUALIZATION_TOOL_NAMES.has(event.name)) {
			continue;
		}
		const detail = await db.getSessionToolEventDetail(
			targetSessionId,
			event.tool_id,
		);
		if (!detail || detail.is_error === 1) continue;
		const result = parseVisualizationToolResult(detail.result_text);
		if (!result || !detail.result_text) continue;
		references.push({
			toolId: event.tool_id,
			result,
			originalResult: detail.result_text,
		});
	}
	if (references.length === 0) return 0;

	await prepareLibrary();
	const canonicalArtifactsRoot = await realpath(artifactsDirectory());
	const replacements = new Map<string, string>();
	const created: CreatedVisualizationCopy[] = [];
	const rewritten: VisualizationReference[] = [];
	try {
		for (const reference of references) {
			const sourceId = reference.result.attachment_id;
			if (replacements.has(sourceId)) continue;
			const source = await db.getAttachment(sourceId);
			if (!source) {
				throw new Error(
					"Forked visualization references an unavailable attachment",
				);
			}
			if (
				source.session_id !== sourceSessionId ||
				source.kind !== "ephemeral" ||
				source.category !== "visualization" ||
				source.retention !== "session" ||
				source.origin !== "generated" ||
				source.mime !== "text/html" ||
				source.filename !== reference.result.filename
			) {
				throw new Error(
					"Forked visualization attachment is not an eligible source-session artifact",
				);
			}

			const sourceDirectory = artifactDirectory(source.id);
			const [sourceDirectoryStats, sourceStats] = await Promise.all([
				lstat(sourceDirectory),
				lstat(source.path),
			]);
			if (
				sourceDirectoryStats.isSymbolicLink() ||
				!sourceDirectoryStats.isDirectory() ||
				sourceStats.isSymbolicLink() ||
				!sourceStats.isFile()
			) {
				throw new Error(
					"Forked visualization source is not a regular unlinked artifact",
				);
			}
			const [canonicalSourceDirectory, canonicalSourcePath] = await Promise.all(
				[realpath(sourceDirectory), realpath(source.path)],
			);
			if (
				!pathStartsWith(canonicalArtifactsRoot, canonicalSourceDirectory) ||
				!pathStartsWith(canonicalSourceDirectory, canonicalSourcePath)
			) {
				throw new Error(
					"Forked visualization source escapes Hlid-owned artifact storage",
				);
			}
			const bytes = Buffer.from(await readFile(canonicalSourcePath));
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			if (
				bytes.byteLength === 0 ||
				bytes.byteLength !== source.size_bytes ||
				sha256 !== source.sha256
			) {
				throw new Error(
					"Forked visualization source no longer matches its attachment record",
				);
			}

			const id = randomUUID();
			const directory = artifactDirectory(id);
			const destination = artifactPath(id, source.filename);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			created.push({ id, path: destination, directory });
			await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
			await db.createAttachment({
				id,
				session_id: targetSessionId,
				kind: "ephemeral",
				filename: source.filename,
				path: destination,
				mime: "text/html",
				size_bytes: bytes.byteLength,
				sha256,
				storage_key: storageKey(destination),
				category: "visualization",
				retention: "session",
				origin: "generated",
				agent_cwd: source.agent_cwd ?? null,
			});
			replacements.set(sourceId, id);
		}

		for (const reference of references) {
			const replacement = replacements.get(reference.result.attachment_id);
			if (!replacement) continue;
			await db.setToolEventResult(
				targetSessionId,
				reference.toolId,
				JSON.stringify({
					...reference.result,
					attachment_id: replacement,
				}),
				false,
			);
			rewritten.push(reference);
		}
		return created.length;
	} catch (error) {
		for (const reference of [...rewritten].reverse()) {
			await db
				.setToolEventResult(
					targetSessionId,
					reference.toolId,
					reference.originalResult,
					false,
				)
				.catch(() => {});
		}
		await removeCreatedCopies(created);
		throw error;
	}
}
