import type {
	ProviderCapabilityDiscovery,
	ProviderCapabilityEvidence,
	ProviderCapabilityMaturity,
} from "../lib/providerCapabilityTypes";
import { providerCapabilityId } from "./providerCapabilities";

type CapabilityRequest = (method: string, params: unknown) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function list(value: unknown, keys: string[]): unknown[] {
	if (Array.isArray(value)) return value;
	const item = record(value);
	for (const key of keys) {
		if (Array.isArray(item[key])) return item[key] as unknown[];
	}
	return [];
}

function textValue(
	item: Record<string, unknown>,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = item[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function booleanValue(
	item: Record<string, unknown>,
	keys: string[],
): boolean | undefined {
	for (const key of keys) {
		if (typeof item[key] === "boolean") return item[key] as boolean;
	}
	return undefined;
}

function maturity(value: unknown): ProviderCapabilityMaturity {
	if (value === "stable") return "stable";
	if (value === "beta") return "beta";
	if (value === "deprecated") return "deprecated";
	if (value === "removed") return "removed";
	if (value === "underDevelopment") return "experimental";
	return "unknown";
}

function issueMessage(method: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `${method} unavailable${detail ? `: ${detail}` : ""}`;
}

function experimentalEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	return list(response, ["data", "features"]).flatMap((value) => {
		const item = record(value);
		const name = textValue(item, ["name", "id"]);
		if (!name) return [];
		const enabled = booleanValue(item, ["enabled", "defaultEnabled"]);
		const stage = maturity(item.stage);
		return [
			{
				id: providerCapabilityId(providerId, "experimental-feature", name),
				label: textValue(item, ["displayName"]) ?? name,
				scope: "provider" as const,
				support: "advertised" as const,
				integration: "provider-native" as const,
				readiness:
					enabled === false || stage === "removed"
						? ("unavailable" as const)
						: ("ready" as const),
				source: "provider-runtime" as const,
				maturity: stage,
				operations: ["inspect"],
				...(enabled === false
					? { reason: "Disabled by the current provider configuration." }
					: {}),
			},
		];
	});
}

function permissionProfileEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	return list(response, ["data", "profiles", "permissionProfiles"]).flatMap(
		(value) => {
			const item = record(value);
			const id = textValue(item, ["id", "name", "profile"]);
			if (!id) return [];
			const allowed = booleanValue(item, [
				"allowed",
				"available",
				"isAllowed",
				"requirementsSatisfied",
			]);
			return [
				{
					id: providerCapabilityId(providerId, "permission-profile", id),
					label: textValue(item, ["displayName", "name"]) ?? id,
					scope: "workspace" as const,
					support: "advertised" as const,
					integration: "not-integrated" as const,
					readiness:
						allowed === false ? ("unavailable" as const) : ("gated" as const),
					source: "provider-config" as const,
					maturity: "beta" as const,
					operations: ["select"],
					...(allowed === false
						? {
								reason:
									"The provider's effective requirements do not allow this profile.",
							}
						: {}),
				},
			];
		},
	);
}

function collaborationModeEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	return list(response, ["data", "modes", "collaborationModes"]).flatMap(
		(value) => {
			const item = record(value);
			const id = textValue(item, ["id", "name", "mode"]);
			if (!id) return [];
			return [
				{
					id: providerCapabilityId(providerId, "collaboration-mode", id),
					label: textValue(item, ["displayName", "name"]) ?? id,
					scope: "session" as const,
					support: "advertised" as const,
					integration: "not-integrated" as const,
					readiness: "ready" as const,
					source: "provider-runtime" as const,
					maturity: "experimental" as const,
					operations: ["select"],
				},
			];
		},
	);
}

function hookCount(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	const item = record(value);
	const direct = list(item, ["hooks"]);
	if (direct.length) return direct.length;
	return list(item, ["data", "items"]).reduce<number>(
		(total, entry) => total + hookCount(entry),
		0,
	);
}

function hookEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	const count = hookCount(response);
	return [
		{
			id: providerCapabilityId(providerId, "hook-catalog"),
			label: `Hook catalog (${count})`,
			scope: "workspace",
			support: "advertised",
			integration: "provider-native",
			readiness: "ready",
			source: "provider-runtime",
			maturity: "stable",
			operations: ["list"],
		},
	];
}

function connectorHealthEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	const servers = list(response, ["data", "servers"]);
	const missingAuth = servers.filter(
		(value) => textValue(record(value), ["authStatus"]) === "notLoggedIn",
	).length;
	return [
		{
			id: providerCapabilityId(providerId, "connector-health"),
			label: `MCP connector health (${servers.length}; ${missingAuth} need auth)`,
			scope: "account",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "provider-runtime",
			maturity: "stable",
			operations: ["status", "authenticate", "refresh"],
		},
	];
}

export async function discoverCodexProviderCapabilities(input: {
	providerId: string;
	cwd: string;
	request: CapabilityRequest;
}): Promise<ProviderCapabilityDiscovery> {
	const probes = [
		{
			method: "experimentalFeature/list",
			params: { limit: 100 },
			map: experimentalEvidence,
		},
		{
			method: "permissionProfile/list",
			params: { cwd: input.cwd, limit: 100 },
			map: permissionProfileEvidence,
		},
		{
			method: "collaborationMode/list",
			params: {},
			map: collaborationModeEvidence,
		},
		{
			method: "hooks/list",
			params: { cwds: [input.cwd] },
			map: hookEvidence,
		},
		{
			method: "mcpServerStatus/list",
			params: { limit: 100, detail: "full" },
			map: connectorHealthEvidence,
			allowNextCursor: true,
		},
	] as const;
	// Remote app inventory has its own bounded Apps/Connectors route. Keeping
	// app/list and app/installed out of this general snapshot prevents a slow
	// plugin registry sync from delaying unrelated provider capability reads.
	const settled = await Promise.allSettled(
		probes.map((probe) => input.request(probe.method, probe.params)),
	);
	const evidence: ProviderCapabilityEvidence[] = [];
	const issues: string[] = [];
	for (const [index, result] of settled.entries()) {
		const probe = probes[index];
		if (!probe) continue;
		if (result.status === "rejected") {
			issues.push(issueMessage(probe.method, result.reason));
			continue;
		}
		evidence.push(...probe.map(input.providerId, result.value));
		if (record(result.value).nextCursor && !("allowNextCursor" in probe)) {
			issues.push(`${probe.method} returned a truncated first page.`);
		}
	}
	return {
		observedAt: Date.now(),
		context: { cwd: input.cwd },
		evidence,
		...(issues.length ? { issues } : {}),
	};
}
