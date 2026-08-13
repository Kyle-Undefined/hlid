import { createHash } from "node:crypto";
import { z } from "zod";
import { getSetting, saveSetting } from "../db/settings";

export const ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY =
	"acp_target_platform_evidence_v1";
export const ACP_TARGET_PLATFORM_EVIDENCE_MAX_AGE_MS = 30 * 24 * 3600_000;

const MAX_EVIDENCE_ENTRIES = 32;
const MAX_PERSISTED_BYTES = 16 * 1024;
const WslTargetKeySchema = z
	.string()
	.min(5)
	.max(132)
	.regex(/^wsl:[a-z0-9._-]+$/);
const WslTargetIdSchema = z.string().regex(/^wsl-[a-f0-9]{16}$/);

export const AcpTargetPlatformEvidenceSchema = z
	.object({
		targetKey: WslTargetKeySchema,
		targetId: WslTargetIdSchema,
		platform: z.literal("linux"),
		architecture: z.enum(["x64", "arm64"]),
		observedAt: z.number().int().nonnegative().safe(),
	})
	.strict()
	.refine(
		(value) =>
			value.targetId ===
			`wsl-${createHash("sha256")
				.update(value.targetKey)
				.digest("hex")
				.slice(0, 16)}`,
		{
			message: "targetId must identify the exact targetKey",
			path: ["targetId"],
		},
	);

const AcpTargetPlatformEvidenceFileSchema = z
	.object({
		version: z.literal(1),
		entries: z.array(AcpTargetPlatformEvidenceSchema).max(MAX_EVIDENCE_ENTRIES),
	})
	.strict()
	.superRefine((value, context) => {
		const targets = new Set<string>();
		for (const [index, entry] of value.entries.entries()) {
			if (targets.has(entry.targetKey)) {
				context.addIssue({
					code: "custom",
					message: "target evidence must be unique",
					path: ["entries", index, "targetKey"],
				});
			}
			targets.add(entry.targetKey);
		}
	});

export type AcpTargetPlatformEvidence = z.infer<
	typeof AcpTargetPlatformEvidenceSchema
>;

export type AcpTargetPlatformEvidenceLookup = {
	targetKey: string;
	targetId: string;
	now: number;
};

export type AcpTargetPlatformEvidenceStore = {
	load: (
		lookup: AcpTargetPlatformEvidenceLookup,
	) => Promise<AcpTargetPlatformEvidence | null>;
	save: (evidence: AcpTargetPlatformEvidence) => Promise<void>;
};

function parseEvidenceFile(
	raw: string | null,
): z.infer<typeof AcpTargetPlatformEvidenceFileSchema> | null {
	if (raw === null || raw.length > MAX_PERSISTED_BYTES) return null;
	try {
		const parsed = AcpTargetPlatformEvidenceFileSchema.safeParse(
			JSON.parse(raw),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function isCurrent(evidence: AcpTargetPlatformEvidence, now: number): boolean {
	return (
		evidence.observedAt <= now &&
		now - evidence.observedAt <= ACP_TARGET_PLATFORM_EVIDENCE_MAX_AGE_MS
	);
}

async function readEvidenceFile(): Promise<z.infer<
	typeof AcpTargetPlatformEvidenceFileSchema
> | null> {
	try {
		return parseEvidenceFile(
			await getSetting(ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY),
		);
	} catch {
		return null;
	}
}

export async function loadAcpTargetPlatformEvidence(
	lookup: AcpTargetPlatformEvidenceLookup,
): Promise<AcpTargetPlatformEvidence | null> {
	const lookupKey = WslTargetKeySchema.safeParse(lookup.targetKey);
	const lookupId = WslTargetIdSchema.safeParse(lookup.targetId);
	if (
		!lookupKey.success ||
		!lookupId.success ||
		!Number.isSafeInteger(lookup.now)
	)
		return null;
	const stored = await readEvidenceFile();
	const evidence = stored?.entries.find(
		(entry) =>
			entry.targetKey === lookup.targetKey &&
			entry.targetId === lookup.targetId,
	);
	return evidence && isCurrent(evidence, lookup.now) ? evidence : null;
}

let platformEvidenceWriteTail: Promise<void> = Promise.resolve();

export function saveAcpTargetPlatformEvidence(
	evidence: AcpTargetPlatformEvidence,
): Promise<void> {
	const validated = AcpTargetPlatformEvidenceSchema.parse(evidence);
	const write = platformEvidenceWriteTail
		.catch(() => {})
		.then(async () => {
			// A failed read must not turn into a destructive overwrite of evidence
			// owned by another exact target. The caller treats this rejection as a
			// nonfatal persistence miss and can retry after the next live success.
			const stored = parseEvidenceFile(
				await getSetting(ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY),
			);
			const entries = (stored?.entries ?? [])
				.filter(
					(entry) =>
						entry.targetKey !== validated.targetKey &&
						isCurrent(entry, validated.observedAt),
				)
				.concat(validated)
				.sort((left, right) => right.observedAt - left.observedAt)
				.slice(0, MAX_EVIDENCE_ENTRIES);
			await saveSetting(
				ACP_TARGET_PLATFORM_EVIDENCE_SETTING_KEY,
				JSON.stringify({ version: 1, entries }),
			);
		});
	platformEvidenceWriteTail = write.catch(() => {});
	return write;
}

export const persistedAcpTargetPlatformEvidenceStore: AcpTargetPlatformEvidenceStore =
	{
		load: loadAcpTargetPlatformEvidence,
		save: saveAcpTargetPlatformEvidence,
	};
