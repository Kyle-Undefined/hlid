import { createHash } from "node:crypto";
import type { HlidConfig } from "#/config";
import {
	type AcpExecutionTarget,
	AcpExecutionTargetSchema,
	acpExecutionTargetKey,
	acpExecutionTargetLabel,
	HOST_ACP_EXECUTION_TARGET,
} from "#/lib/acpExecutionTarget";
import { parseWslUncSyntax } from "#/lib/paths";

export type AcpExecutionTargetDescriptor = {
	targetId: string;
	target: AcpExecutionTarget;
	label: string;
	cwd: string;
	recommended: boolean;
};

export function acpExecutionTargetId(target: AcpExecutionTarget): string {
	if (target.kind === "host") return "host";
	return `wsl-${createHash("sha256")
		.update(acpExecutionTargetKey(target))
		.digest("hex")
		.slice(0, 16)}`;
}

/**
 * Enumerate only execution targets already owned by Hlid configuration. WSL
 * distro names are derived from exact vault/agent UNC roots rather than from
 * the machine's mutable default distro or browser input.
 */
export function configuredAcpExecutionTargets(
	config: HlidConfig,
	platform: NodeJS.Platform = process.platform,
): AcpExecutionTargetDescriptor[] {
	const configuredPaths = [
		config.vault.path,
		...(config.agents ?? []).map((agent) => agent.path),
	].filter(Boolean);
	// A host probe must never inherit a WSL UNC cwd merely because the vault is
	// in WSL. Use an explicitly configured native workspace when one exists;
	// otherwise the native Hlid process cwd is the only safe host fallback.
	const hostCwd =
		platform === "win32"
			? (configuredPaths.find(
					(path) =>
						!parseWslUncSyntax(path) &&
						(/^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\")),
				) ?? process.cwd())
			: config.vault.path || process.cwd();
	const wslCwds = new Map<string, { distro: string; cwd: string }>();
	for (const path of configuredPaths) {
		const parsed = parseWslUncSyntax(path);
		if (!parsed) continue;
		if (
			!AcpExecutionTargetSchema.safeParse({
				kind: "wsl",
				distro: parsed.distro,
			}).success
		) {
			continue;
		}
		const key = parsed.distro.toLowerCase();
		if (!wslCwds.has(key))
			wslCwds.set(key, { distro: parsed.distro, cwd: path });
	}

	const vaultWsl = parseWslUncSyntax(config.vault.path);
	const uniqueWslRecommended = !vaultWsl && wslCwds.size === 1;
	const hostRecommended = platform !== "win32" || wslCwds.size === 0;
	const descriptors: AcpExecutionTargetDescriptor[] = [
		{
			targetId: acpExecutionTargetId(HOST_ACP_EXECUTION_TARGET),
			target: HOST_ACP_EXECUTION_TARGET,
			label: platform === "win32" ? "Windows" : "Host",
			cwd: hostCwd,
			recommended: hostRecommended,
		},
	];
	if (platform !== "win32") return descriptors;

	for (const [key, value] of wslCwds) {
		const target: AcpExecutionTarget = { kind: "wsl", distro: value.distro };
		descriptors.push({
			targetId: acpExecutionTargetId(target),
			target,
			label: acpExecutionTargetLabel(target),
			cwd: value.cwd,
			recommended:
				vaultWsl?.distro.toLowerCase() === key || uniqueWslRecommended,
		});
	}
	return descriptors;
}

export function configuredAcpExecutionTarget(
	config: HlidConfig,
	targetId: string,
	platform: NodeJS.Platform = process.platform,
): AcpExecutionTargetDescriptor | null {
	return (
		configuredAcpExecutionTargets(config, platform).find(
			(candidate) => candidate.targetId === targetId,
		) ?? null
	);
}
