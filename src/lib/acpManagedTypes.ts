import { z } from "zod";
import type { AcpExecutionTarget } from "./acpExecutionTarget";

export const AcpManagedMutationActionSchema = z.enum([
	"install",
	"update",
	"remove",
]);
export type AcpManagedMutationAction = z.infer<
	typeof AcpManagedMutationActionSchema
>;

export const AcpManagedMutationRequestSchema = z
	.object({
		action: AcpManagedMutationActionSchema,
		agentId: z.string().min(1).max(128),
		targetId: z.string().min(1).max(128),
		revision: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type AcpManagedMutationRequest = z.infer<
	typeof AcpManagedMutationRequestSchema
>;

export async function parseAcpManagedMutationRequest(request: Request) {
	return AcpManagedMutationRequestSchema.safeParse(
		await request.json().catch(() => null),
	);
}

export type AcpManagedOperationPhase =
	| "queued"
	| "downloading"
	| "verifying"
	| "extracting"
	| "probing"
	| "activating"
	| "refreshing"
	| "removing";

export type AcpManagedOperationSnapshot = {
	id: string;
	action: AcpManagedMutationAction;
	phase: AcpManagedOperationPhase;
	received?: number;
	total?: number | null;
	cancelable: boolean;
};

export type AcpTargetProvenance = "missing" | "external" | "managed";

/** Display-safe server-derived status for one exact ACP execution target. */
export type AcpTargetStatus = {
	targetId: string;
	target: AcpExecutionTarget;
	label: string;
	recommended: boolean;
	selected: boolean;
	platformTarget: string;
	provenance: AcpTargetProvenance;
	available: boolean;
	canEnable: boolean;
	canInstall: boolean;
	canUpdate: boolean;
	canRemove: boolean;
	/** Receipt-backed target retained only so Hlid-managed files can be removed. */
	cleanupOnly?: boolean;
	registryVersion: string;
	/** Opaque revision binding confirmation to this exact registry/install state. */
	mutationRevision: string;
	installedVersion?: string;
	observedVersion?: string;
	resolvedExecutable?: string;
	command: string;
	args: string[];
	installGuidance: string;
	blockedReason?: string;
	operation?: AcpManagedOperationSnapshot;
	error?: string;
};
