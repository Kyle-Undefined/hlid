import { createHash } from "node:crypto";
import {
	PROVIDER_CAPABILITY_CONTRACT_VERSION,
	type ProviderCapabilityAvailability,
	type ProviderCapabilityDescriptor,
	type ProviderCapabilityDiscovery,
	type ProviderCapabilityEvidence,
	type ProviderCapabilitySnapshot,
} from "../lib/providerCapabilityTypes";
import type {
	ProviderCapabilityMetadata,
	ProviderForkCapability,
	ProviderModelInfo,
} from "./agentProvider";
import type { CatalogSource } from "./providerCatalog";

const MAX_CAPABILITIES = 200;
const MAX_ISSUES = 10;

function bounded(value: string, max: number): string {
	const normalized = value.trim();
	return normalized.length <= max ? normalized : normalized.slice(0, max);
}

function boundedOperations(
	operations: string[] | undefined,
): string[] | undefined {
	if (!operations?.length) return undefined;
	return [
		...new Set(operations.map((item) => bounded(item, 80)).filter(Boolean)),
	]
		.sort()
		.slice(0, 20);
}

function normalizeEvidence(
	evidence: ProviderCapabilityEvidence,
): ProviderCapabilityEvidence | null {
	const id = bounded(evidence.id, 240);
	const label = bounded(evidence.label, 200);
	if (!id || !label) return null;
	return {
		...evidence,
		id,
		label,
		...(evidence.operations
			? { operations: boundedOperations(evidence.operations) }
			: {}),
		...(evidence.reason ? { reason: bounded(evidence.reason, 500) } : {}),
	};
}

export function providerCapabilityId(
	providerId: string,
	...segments: string[]
): string {
	return [providerId, ...segments]
		.map((segment) => encodeURIComponent(segment.trim().toLowerCase()))
		.join(":");
}

function availabilityFor(
	evidence: ProviderCapabilityEvidence,
	providerAvailable: boolean,
): ProviderCapabilityAvailability {
	if (!providerAvailable || evidence.support === "not-advertised") {
		return "unavailable";
	}
	if (evidence.integration === "not-integrated") return "unavailable";
	if (evidence.readiness === "unavailable") return "unavailable";
	if (
		evidence.support === "unknown" ||
		evidence.readiness === "unknown" ||
		evidence.readiness === "gated"
	) {
		return "conditional";
	}
	return evidence.integration === "provider-native"
		? "provider-native"
		: "available";
}

function staticEvidence(input: {
	providerId: string;
	capabilities?: ProviderCapabilityMetadata;
	forkCapability?: ProviderForkCapability;
	models: ProviderModelInfo[];
	permissionModes?: ReadonlyArray<{ value: string; label: string }>;
}): ProviderCapabilityEvidence[] {
	const { providerId, capabilities, forkCapability, models, permissionModes } =
		input;
	const evidence: ProviderCapabilityEvidence[] = [];
	if (capabilities?.goalControl) {
		evidence.push({
			id: providerCapabilityId(providerId, "goal-control"),
			label: "Durable goal control",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["get", "set", "clear"],
		});
	}
	for (const activity of capabilities?.structuredActivities ?? []) {
		evidence.push({
			id: providerCapabilityId(providerId, "structured-activity", activity),
			label: `${activity[0]?.toUpperCase() ?? ""}${activity.slice(1)} activity`,
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["start"],
		});
	}
	if (capabilities?.workflowCatalog) {
		evidence.push({
			id: providerCapabilityId(providerId, "workflow-catalog"),
			label: "Reusable workflow catalog",
			scope: "workspace",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["list", "read", "save", "delete"],
		});
	}
	if (capabilities?.realtime) {
		evidence.push({
			id: providerCapabilityId(providerId, "realtime"),
			label: "Realtime conversation transport",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "gated",
			source: "hlid-adapter",
			maturity: "experimental",
			operations: ["start", "append-speech", "stop"],
			reason: "Selected model, Hlid configuration, and backend still gate use.",
		});
	}
	if (capabilities?.appCatalog) {
		evidence.push({
			id: providerCapabilityId(providerId, "app-catalog"),
			label: "Apps and connector catalog",
			scope: "account",
			support: "advertised",
			integration: "integrated",
			readiness: "gated",
			source: "hlid-adapter",
			maturity: "experimental",
			operations: ["list", "read", "refresh"],
			reason: "Live provider inventory still determines current readiness.",
		});
	}
	if (capabilities?.appAuthentication) {
		evidence.push({
			id: providerCapabilityId(providerId, "app-authentication"),
			label: "App and connector authentication",
			scope: "account",
			support: "advertised",
			integration: "integrated",
			readiness: "gated",
			source: "hlid-adapter",
			maturity: "experimental",
			operations: ["start", "observe-completion"],
			reason:
				"Live provider inventory still determines whether authentication is required.",
		});
	}
	if (capabilities?.backgroundActivities) {
		evidence.push({
			id: providerCapabilityId(providerId, "background-activity"),
			label: "Background activity",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "gated",
			source: "hlid-adapter",
			maturity: capabilities.backgroundActivities.maturity,
			operations: [...capabilities.backgroundActivities.operations],
			reason:
				"Only a live direct provider session can observe or control native background work.",
		});
	}
	if (forkCapability) {
		evidence.push({
			id: providerCapabilityId(providerId, "exact-fork"),
			label: forkCapability.throughMessage
				? `Exact ${forkCapability.cutoff ?? "session"} fork`
				: "Exact whole-session fork",
			scope: "session",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["fork"],
		});
	}
	if (models.length > 0) {
		evidence.push({
			id: providerCapabilityId(providerId, "model-catalog"),
			label: `Model catalog (${models.length})`,
			scope: "provider",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["list", "select"],
		});
	}
	if (permissionModes?.length) {
		evidence.push({
			id: providerCapabilityId(providerId, "permission-mode-catalog"),
			label: `Permission modes (${permissionModes.length})`,
			scope: "provider",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			source: "hlid-adapter",
			maturity: "stable",
			operations: ["list", "select"],
		});
	}
	return evidence;
}

function capabilityReason(
	evidence: ProviderCapabilityEvidence,
	availability: ProviderCapabilityAvailability,
	providerAvailable: boolean,
	providerUnavailableReason?: string,
): string | undefined {
	if (!providerAvailable) {
		return providerUnavailableReason ?? "Provider is unavailable.";
	}
	if (evidence.reason) return evidence.reason;
	if (evidence.support === "not-advertised") {
		return "The provider does not advertise this capability.";
	}
	if (evidence.integration === "not-integrated") {
		return "The provider advertises this capability, but Hlid does not integrate it yet.";
	}
	if (availability === "conditional") {
		return "Availability depends on the active provider context.";
	}
	return undefined;
}

function snapshotStatus(input: {
	providerAvailable: boolean;
	source: ProviderCapabilitySnapshot["source"];
	issues: string[];
}): ProviderCapabilitySnapshot["status"] {
	if (!input.providerAvailable) return "unavailable";
	if (input.issues.length > 0 || input.source === "fallback") return "partial";
	if (input.source === "persisted") return "stale";
	return "current";
}

export function buildProviderCapabilitySnapshot(input: {
	providerId: string;
	providerAvailable: boolean;
	providerUnavailableReason?: string;
	capabilities?: ProviderCapabilityMetadata;
	forkCapability?: ProviderForkCapability;
	models: ProviderModelInfo[];
	permissionModes?: ReadonlyArray<{ value: string; label: string }>;
	discovery?: ProviderCapabilityDiscovery;
	discoverySource?: CatalogSource;
	discoveryCwd?: string;
}): ProviderCapabilitySnapshot {
	const discoveryCwd = input.discovery?.context?.cwd ?? input.discoveryCwd;
	const source: ProviderCapabilitySnapshot["source"] = input.discoverySource
		? input.discoverySource
		: "adapter";
	const issues = (input.discovery?.issues ?? [])
		.map((issue) => bounded(issue, 300))
		.filter(Boolean)
		.slice(0, MAX_ISSUES);
	const evidenceById = new Map<string, ProviderCapabilityEvidence>();
	for (const candidate of [
		...staticEvidence(input),
		...(input.discovery?.evidence ?? []),
	]) {
		const normalized = normalizeEvidence(candidate);
		if (normalized) evidenceById.set(normalized.id, normalized);
	}
	const capabilities = [...evidenceById.values()]
		.sort((a, b) => a.id.localeCompare(b.id))
		.slice(0, MAX_CAPABILITIES)
		.map((evidence): ProviderCapabilityDescriptor => {
			const availability = availabilityFor(evidence, input.providerAvailable);
			const reason = capabilityReason(
				evidence,
				availability,
				input.providerAvailable,
				input.providerUnavailableReason,
			);
			return { ...evidence, availability, ...(reason ? { reason } : {}) };
		});
	if (evidenceById.size > MAX_CAPABILITIES) {
		issues.push(
			`Capability inventory was truncated at ${MAX_CAPABILITIES} items.`,
		);
	}
	const status = snapshotStatus({
		providerAvailable: input.providerAvailable,
		source,
		issues,
	});
	const revisionPayload = {
		contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
		providerId: input.providerId,
		status,
		source,
		...(discoveryCwd ? { context: { cwd: bounded(discoveryCwd, 500) } } : {}),
		capabilities,
		issues,
	};
	const revision = `v${PROVIDER_CAPABILITY_CONTRACT_VERSION}-${createHash(
		"sha256",
	)
		.update(JSON.stringify(revisionPayload))
		.digest("hex")
		.slice(0, 12)}`;
	return {
		contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
		providerId: bounded(input.providerId, 120),
		status,
		source,
		revision,
		observedAt: input.discovery?.observedAt ?? Date.now(),
		...(discoveryCwd ? { context: { cwd: bounded(discoveryCwd, 500) } } : {}),
		capabilities,
		...(issues.length ? { issues } : {}),
	};
}

export function isProviderCapabilityDiscovery(
	value: unknown,
): value is ProviderCapabilityDiscovery {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const scopes = new Set([
		"provider",
		"account",
		"host",
		"model",
		"workspace",
		"session",
	]);
	const supports = new Set(["advertised", "not-advertised", "unknown"]);
	const integrations = new Set([
		"integrated",
		"provider-native",
		"not-integrated",
	]);
	const readiness = new Set(["ready", "gated", "unavailable", "unknown"]);
	const sources = new Set([
		"hlid-adapter",
		"provider-runtime",
		"provider-sdk",
		"provider-config",
		"host-runtime",
	]);
	return (
		typeof record.observedAt === "number" &&
		Number.isFinite(record.observedAt) &&
		record.observedAt >= 0 &&
		Array.isArray(record.evidence) &&
		record.evidence.length <= 1_000 &&
		record.evidence.every((item) => {
			if (!item || typeof item !== "object") return false;
			const evidence = item as Record<string, unknown>;
			return (
				typeof evidence.id === "string" &&
				typeof evidence.label === "string" &&
				typeof evidence.scope === "string" &&
				scopes.has(evidence.scope) &&
				typeof evidence.support === "string" &&
				supports.has(evidence.support) &&
				typeof evidence.integration === "string" &&
				integrations.has(evidence.integration) &&
				typeof evidence.readiness === "string" &&
				readiness.has(evidence.readiness) &&
				typeof evidence.source === "string" &&
				sources.has(evidence.source) &&
				(evidence.operations === undefined ||
					(Array.isArray(evidence.operations) &&
						evidence.operations.every(
							(operation) => typeof operation === "string",
						))) &&
				(evidence.reason === undefined || typeof evidence.reason === "string")
			);
		}) &&
		(record.context === undefined ||
			(record.context !== null &&
				typeof record.context === "object" &&
				typeof (record.context as Record<string, unknown>).cwd === "string" &&
				((record.context as Record<string, unknown>).cwd as string).length <=
					4_096)) &&
		(record.issues === undefined ||
			(Array.isArray(record.issues) &&
				record.issues.length <= 100 &&
				record.issues.every((issue) => typeof issue === "string")))
	);
}
