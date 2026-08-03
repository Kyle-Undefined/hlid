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
import type { AttachmentRow } from "../db/types";
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
const GENERATED_MEDIA_TOOL_NAMES = new Set([
	"ImageGeneration",
	"imageGeneration",
]);

type AttachmentToolResult = Record<string, unknown> & {
	attachment_id: string;
	filename: string;
};

type AttachmentReference = {
	toolId: string;
	assistantSeq: number;
	result: AttachmentToolResult;
	originalResult: string;
};

type CreatedAttachmentCopy = {
	id: string;
	path: string;
	directory: string;
};

type ForkAttachmentSpec = {
	label: string;
	toolNames: ReadonlySet<string>;
	parseResult: (resultText: string | null) => AttachmentToolResult | null;
	isEligible: (
		source: AttachmentRow,
		result: AttachmentToolResult,
		sourceSessionId: string,
	) => boolean;
	linkToMessage: boolean;
};

function parsedResult(
	resultText: string | null,
): Record<string, unknown> | null {
	if (!resultText) return null;
	let value: unknown;
	try {
		value = JSON.parse(resultText);
	} catch {
		return null;
	}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function attachmentResult(
	result: Record<string, unknown> | null,
): AttachmentToolResult | null {
	if (
		typeof result?.attachment_id !== "string" ||
		!result.attachment_id ||
		typeof result.filename !== "string" ||
		!result.filename
	) {
		return null;
	}
	return result as AttachmentToolResult;
}

function parseVisualizationToolResult(
	resultText: string | null,
): AttachmentToolResult | null {
	const result = parsedResult(resultText);
	return result?.type === "hlid_visualization"
		? attachmentResult(result)
		: null;
}

function parseGeneratedMediaToolResult(
	resultText: string | null,
): AttachmentToolResult | null {
	const result = parsedResult(resultText);
	return result?.type === "hlid_generated_media" &&
		result.version === 1 &&
		result.status === "ready" &&
		result.mime === "image/png"
		? attachmentResult(result)
		: null;
}

async function removeCreatedCopies(
	created: readonly CreatedAttachmentCopy[],
): Promise<void> {
	for (const copy of [...created].reverse()) {
		await db.deleteAttachment(copy.id).catch(() => null);
		await unlink(copy.path).catch(() => {});
		await rmdir(copy.directory).catch(() => {});
	}
}

async function copyForkedManagedAttachments(
	sourceSessionId: string,
	targetSessionId: string,
	spec: ForkAttachmentSpec,
): Promise<number> {
	const references: AttachmentReference[] = [];
	for (const event of await db.getSessionToolEventSummaries(targetSessionId)) {
		if (event.is_error === 1 || !spec.toolNames.has(event.name)) continue;
		const detail = await db.getSessionToolEventDetail(
			targetSessionId,
			event.tool_id,
		);
		if (!detail || detail.is_error === 1) continue;
		const result = spec.parseResult(detail.result_text);
		if (!result || !detail.result_text) continue;
		references.push({
			toolId: event.tool_id,
			assistantSeq: event.assistant_seq,
			result,
			originalResult: detail.result_text,
		});
	}
	if (references.length === 0) return 0;

	await prepareLibrary();
	const canonicalArtifactsRoot = await realpath(artifactsDirectory());
	const replacements = new Map<string, string>();
	const created: CreatedAttachmentCopy[] = [];
	const rewritten: AttachmentReference[] = [];
	try {
		for (const reference of references) {
			const sourceId = reference.result.attachment_id;
			if (replacements.has(sourceId)) continue;
			const source = await db.getAttachment(sourceId);
			if (!source) {
				throw new Error(
					`Forked ${spec.label} references an unavailable attachment`,
				);
			}
			if (!spec.isEligible(source, reference.result, sourceSessionId)) {
				throw new Error(
					`Forked ${spec.label} attachment is not an eligible source-session artifact`,
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
					`Forked ${spec.label} source is not a regular unlinked artifact`,
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
					`Forked ${spec.label} source escapes Hlid-owned artifact storage`,
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
					`Forked ${spec.label} source no longer matches its attachment record`,
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
				mime: source.mime,
				size_bytes: bytes.byteLength,
				sha256,
				storage_key: storageKey(destination),
				category: source.category,
				retention: source.retention,
				origin: "generated",
				agent_cwd: source.agent_cwd ?? null,
				image_optimized_at: source.image_optimized_at ?? null,
				original_size_bytes: source.original_size_bytes ?? null,
			});
			if (spec.linkToMessage) {
				const linked = await db.linkAttachmentToMessage(
					id,
					targetSessionId,
					reference.assistantSeq,
				);
				if (!linked) {
					throw new Error(
						`Forked ${spec.label} could not be linked to its assistant turn`,
					);
				}
			}
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

/** Give a fork independent ownership of each session-retained visualization. */
export function copyForkedVisualizationAttachments(
	sourceSessionId: string,
	targetSessionId: string,
): Promise<number> {
	return copyForkedManagedAttachments(sourceSessionId, targetSessionId, {
		label: "visualization",
		toolNames: VISUALIZATION_TOOL_NAMES,
		parseResult: parseVisualizationToolResult,
		linkToMessage: false,
		isEligible: (source, result, sourceId) =>
			source.session_id === sourceId &&
			source.kind === "ephemeral" &&
			source.category === "visualization" &&
			source.retention === "session" &&
			source.origin === "generated" &&
			source.mime === "text/html" &&
			source.filename === result.filename,
	});
}

/** Give a fork an independent generated image and rewrite its compact receipt. */
export function copyForkedGeneratedMediaAttachments(
	sourceSessionId: string,
	targetSessionId: string,
): Promise<number> {
	return copyForkedManagedAttachments(sourceSessionId, targetSessionId, {
		label: "generated media",
		toolNames: GENERATED_MEDIA_TOOL_NAMES,
		parseResult: parseGeneratedMediaToolResult,
		linkToMessage: true,
		isEligible: (source, result, sourceId) =>
			source.session_id === sourceId &&
			source.kind === "ephemeral" &&
			source.category === "media" &&
			source.retention === "retained" &&
			source.origin === "generated" &&
			source.mime === "image/png" &&
			source.filename === result.filename,
	});
}

/** Copy every Hlid-owned artifact referenced by the forked visible transcript. */
export async function copyForkedSessionAttachments(
	sourceSessionId: string,
	targetSessionId: string,
): Promise<number> {
	const visualizations = await copyForkedVisualizationAttachments(
		sourceSessionId,
		targetSessionId,
	);
	const media = await copyForkedGeneratedMediaAttachments(
		sourceSessionId,
		targetSessionId,
	);
	return visualizations + media;
}
