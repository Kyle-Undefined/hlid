import { z } from "zod";

export const AcpExecutionTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("host") }),
	z.object({
		kind: z.literal("wsl"),
		distro: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9._-]+$/, "Invalid WSL distro name"),
	}),
]);

export type AcpExecutionTarget = z.infer<typeof AcpExecutionTargetSchema>;

export const HOST_ACP_EXECUTION_TARGET: AcpExecutionTarget = { kind: "host" };

export function normalizeAcpExecutionTarget(
	target: AcpExecutionTarget | undefined,
): AcpExecutionTarget {
	return target ?? HOST_ACP_EXECUTION_TARGET;
}

export function acpExecutionTargetKey(
	target: AcpExecutionTarget | undefined,
): string {
	const normalized = normalizeAcpExecutionTarget(target);
	return normalized.kind === "host"
		? "host"
		: `wsl:${normalized.distro.toLowerCase()}`;
}

export function acpExecutionTargetLabel(
	target: AcpExecutionTarget | undefined,
): string {
	const normalized = normalizeAcpExecutionTarget(target);
	return normalized.kind === "host" ? "Windows" : `WSL · ${normalized.distro}`;
}
