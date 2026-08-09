import type {
	ProviderCapabilityDiscovery,
	ProviderCapabilityEvidence,
	ProviderCapabilityMaturity,
} from "../lib/providerCapabilityTypes";
import type {
	PermissionProfileListParams,
	PermissionProfileListResponse,
	PermissionProfileSummary,
} from "./codexProtocol";
import { providerCapabilityId } from "./providerCapabilities";

type CapabilityRequest = (method: string, params: unknown) => Promise<unknown>;

const PERMISSION_PROFILE_PAGE_SIZE = 100;
const PERMISSION_PROFILE_MAX_PAGES = 10;
const PERMISSION_PROFILE_MAX_TEXT_LENGTH = 500;

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
		const approvalReviewerSelection =
			name.toLowerCase() === "guardian_approval";
		return [
			{
				id: providerCapabilityId(providerId, "experimental-feature", name),
				label: textValue(item, ["displayName"]) ?? name,
				scope: approvalReviewerSelection
					? ("session" as const)
					: ("provider" as const),
				support: "advertised" as const,
				integration: approvalReviewerSelection
					? ("integrated" as const)
					: ("provider-native" as const),
				readiness:
					enabled === false || stage === "removed"
						? ("unavailable" as const)
						: ("ready" as const),
				source: "provider-runtime" as const,
				maturity: stage,
				operations: approvalReviewerSelection
					? ["inspect", "select"]
					: ["inspect"],
				...(enabled === false
					? { reason: "Disabled by the current provider configuration." }
					: {}),
			},
		];
	});
}

function permissionProfileEvidence(
	providerId: string,
	profiles: readonly PermissionProfileSummary[],
): ProviderCapabilityEvidence[] {
	return profiles.map((profile) => ({
		id: providerCapabilityId(providerId, "permission-profile", profile.id),
		label: profile.id,
		scope: "workspace" as const,
		support: "advertised" as const,
		integration: "integrated" as const,
		readiness: profile.allowed ? ("ready" as const) : ("unavailable" as const),
		source: "provider-config" as const,
		maturity: "beta" as const,
		operations: ["select"],
		...(!profile.allowed
			? {
					reason:
						"The provider's effective requirements do not allow this profile.",
				}
			: {}),
	}));
}

function parsePermissionProfile(value: unknown): PermissionProfileSummary {
	const item = record(value);
	const id = typeof item.id === "string" ? item.id.trim() : "";
	if (
		!id ||
		id.length > PERMISSION_PROFILE_MAX_TEXT_LENGTH ||
		typeof item.allowed !== "boolean"
	) {
		throw new Error("permissionProfile/list returned a malformed profile");
	}
	if (
		item.description !== undefined &&
		item.description !== null &&
		typeof item.description !== "string"
	) {
		throw new Error(
			`permissionProfile/list returned a malformed description for ${id}`,
		);
	}
	const rawDescription =
		typeof item.description === "string" && item.description.trim()
			? item.description.trim()
			: null;
	const description = rawDescription
		? rawDescription.slice(0, PERMISSION_PROFILE_MAX_TEXT_LENGTH)
		: null;
	return { id, description, allowed: item.allowed };
}

/** Read the complete cwd-scoped native catalog without silently truncating it. */
export async function readCodexPermissionProfiles(input: {
	cwd: string;
	request: CapabilityRequest;
}): Promise<PermissionProfileSummary[]> {
	const profiles = new Map<string, PermissionProfileSummary>();
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	for (let page = 0; page < PERMISSION_PROFILE_MAX_PAGES; page++) {
		const params = {
			cwd: input.cwd,
			limit: PERMISSION_PROFILE_PAGE_SIZE,
			...(cursor ? { cursor } : {}),
		} satisfies PermissionProfileListParams;
		const raw = record(await input.request("permissionProfile/list", params));
		if (!Array.isArray(raw.data)) {
			throw new Error("permissionProfile/list returned no profile array");
		}
		if (raw.data.length > PERMISSION_PROFILE_PAGE_SIZE) {
			throw new Error(
				`permissionProfile/list returned more than ${PERMISSION_PROFILE_PAGE_SIZE} profiles in one page`,
			);
		}
		const response = raw as PermissionProfileListResponse;
		for (const value of response.data) {
			const profile = parsePermissionProfile(value);
			if (profiles.has(profile.id)) {
				throw new Error(
					`permissionProfile/list returned duplicate profile ${profile.id}`,
				);
			}
			profiles.set(profile.id, profile);
		}
		if (
			raw.nextCursor !== undefined &&
			raw.nextCursor !== null &&
			typeof raw.nextCursor !== "string"
		) {
			throw new Error("permissionProfile/list returned a malformed nextCursor");
		}
		const nextCursor =
			typeof raw.nextCursor === "string" && raw.nextCursor
				? raw.nextCursor
				: null;
		if (!nextCursor) return [...profiles.values()];
		if (seenCursors.has(nextCursor)) {
			throw new Error("permissionProfile/list repeated its pagination cursor");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	throw new Error(
		`permissionProfile/list exceeded ${PERMISSION_PROFILE_MAX_PAGES} pages`,
	);
}

function collaborationModeEvidence(
	providerId: string,
	response: unknown,
): ProviderCapabilityEvidence[] {
	const integratedModes = new Set(["default", "plan"]);
	return list(response, ["data", "modes", "collaborationModes"]).flatMap(
		(value) => {
			const item = record(value);
			const id = textValue(item, ["id", "name", "mode"]);
			if (!id) return [];
			const normalizedId = id.toLowerCase();
			const integrated = integratedModes.has(normalizedId);
			return [
				{
					id: providerCapabilityId(providerId, "collaboration-mode", id),
					label: textValue(item, ["displayName", "name"]) ?? id,
					scope: "session" as const,
					support: "advertised" as const,
					integration: integrated
						? ("integrated" as const)
						: ("not-integrated" as const),
					readiness: "ready" as const,
					source: "provider-runtime" as const,
					maturity: "experimental" as const,
					operations: ["select"],
					...(normalizedId === "default"
						? {
								reason:
									"Raven selects Codex's native Default mode for ordinary turns.",
							}
						: normalizedId === "plan"
							? {
									reason:
										"Raven selects native Plan for plain planning. HTML plans remain Hlid-managed so Codex can write the review artifact.",
								}
							: {}),
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
	type Probe = {
		method: string;
		load: () => Promise<unknown>;
		map: (
			providerId: string,
			response: unknown,
		) => ProviderCapabilityEvidence[];
		allowNextCursor?: boolean;
	};
	const probes: Probe[] = [
		{
			method: "experimentalFeature/list",
			load: () => input.request("experimentalFeature/list", { limit: 100 }),
			map: experimentalEvidence,
		},
		{
			method: "permissionProfile/list",
			load: () =>
				readCodexPermissionProfiles({ cwd: input.cwd, request: input.request }),
			map: (providerId, response) =>
				permissionProfileEvidence(
					providerId,
					response as PermissionProfileSummary[],
				),
		},
		{
			method: "collaborationMode/list",
			load: () => input.request("collaborationMode/list", {}),
			map: collaborationModeEvidence,
		},
		{
			method: "hooks/list",
			load: () => input.request("hooks/list", { cwds: [input.cwd] }),
			map: hookEvidence,
		},
		{
			method: "mcpServerStatus/list",
			load: () =>
				input.request("mcpServerStatus/list", { limit: 100, detail: "full" }),
			map: connectorHealthEvidence,
			allowNextCursor: true,
		},
	] as const;
	// Remote app inventory has its own bounded Apps/Connectors route. Keeping
	// app/list and app/installed out of this general snapshot prevents a slow
	// plugin registry sync from delaying unrelated provider capability reads.
	const settled = await Promise.allSettled(probes.map((probe) => probe.load()));
	const evidence: ProviderCapabilityEvidence[] = [];
	const issues: string[] = [];
	let permissionProfiles: ProviderCapabilityDiscovery["permissionProfiles"];
	for (const [index, result] of settled.entries()) {
		const probe = probes[index];
		if (!probe) continue;
		if (result.status === "rejected") {
			issues.push(issueMessage(probe.method, result.reason));
			continue;
		}
		evidence.push(...probe.map(input.providerId, result.value));
		if (probe.method === "permissionProfile/list") {
			permissionProfiles = (result.value as PermissionProfileSummary[]).map(
				(profile) => ({
					id: profile.id,
					...(profile.description ? { description: profile.description } : {}),
					allowed: profile.allowed,
				}),
			);
		}
		if (record(result.value).nextCursor && !("allowNextCursor" in probe)) {
			issues.push(`${probe.method} returned a truncated first page.`);
		}
	}
	return {
		observedAt: Date.now(),
		context: { cwd: input.cwd },
		...(permissionProfiles ? { permissionProfiles } : {}),
		evidence,
		...(issues.length ? { issues } : {}),
	};
}
