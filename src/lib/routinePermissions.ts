import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	RoutineDefinition,
	RoutineGrantCapability,
	RoutinePermissionGrantInput,
	RoutinePermissionMode,
} from "./routines";

export const ROUTINE_PERMISSION_MATCHER_VERSION = 1;

export type CanonicalRoutineCapability = {
	capability: RoutineGrantCapability;
	tool: string;
	cwd: string;
	path?: string;
	command?: string;
	input: Record<string, unknown>;
};

export type RoutineGrant = RoutinePermissionGrantInput & {
	id: string;
	usesThisRun?: number;
};

export type RoutinePermissionContext = {
	routineId: string;
	runId: string;
	profileId: string;
	revision: number;
	authorizationFingerprint: string;
	mode: RoutinePermissionMode;
	providerId: string;
	approvedCwd: string;
	grants: RoutineGrant[];
	actionRequired?: {
		tool: string;
		reason: string;
		capability?: CanonicalRoutineCapability;
	};
	onGrantUsed?: (
		grant: RoutineGrant,
		request: CanonicalRoutineCapability,
		toolUseId: string,
	) => void | Promise<void>;
	onActionRequired?: (
		reason: string,
		request?: CanonicalRoutineCapability,
	) => void | Promise<void>;
};

const NEVER_PREAPPROVE = new Set([
	"AskUserQuestion",
	"ExitPlanMode",
	"hlid.windows_computer_use",
	"hlid__windows_computer_use",
	"hlid.windows_computer_use:*",
]);

const READ_TOOL =
	/^(read|glob|grep|search|find|list|view|get|fetch|open|status)/i;
const WRITE_TOOL =
	/^(write|edit|patch|create|append|prepend|move|rename|delete|remove)/i;
const SHELL_TOOL = /^(bash|shell|exec|execute|terminal|run_command)$/i;

function inputString(
	input: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function normalizeRoutineCapability(options: {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
}): CanonicalRoutineCapability | null {
	const { tool, input } = options;
	if (
		NEVER_PREAPPROVE.has(tool) ||
		tool.startsWith("hlid.windows_computer_use:")
	)
		return null;
	const lower = tool.toLowerCase();
	const path = inputString(input, "file_path", "path", "target", "source");
	const command = inputString(input, "command", "cmd");
	let capability: RoutineGrantCapability;
	if (SHELL_TOOL.test(tool) || command) capability = "shell.exec";
	else if (lower.includes("obsidian")) capability = "obsidian.call";
	else if (lower.startsWith("hlid") || lower.includes("publish_relic"))
		capability = "hlid.call";
	else if (tool.includes("__") || lower.startsWith("mcp"))
		capability = "mcp.call";
	else if (WRITE_TOOL.test(tool)) capability = "fs.write";
	else if (READ_TOOL.test(tool)) capability = "fs.read";
	else capability = "tool.call";
	return {
		capability,
		tool,
		cwd: resolve(options.cwd),
		...(path ? { path: resolve(options.cwd, path) } : {}),
		...(command ? { command } : {}),
		input,
	};
}

function pathWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scalarInputMatches(
	constraints: RoutinePermissionGrantInput["input"],
	input: Record<string, unknown>,
): boolean {
	if (!constraints) return true;
	return Object.entries(constraints).every(
		([key, expected]) => input[key] === expected,
	);
}

export function matchRoutineGrant(
	context: RoutinePermissionContext,
	request: CanonicalRoutineCapability,
	nowEpochSeconds = Math.floor(Date.now() / 1_000),
): RoutineGrant | null {
	if (resolve(context.approvedCwd) !== request.cwd) return null;
	if (context.mode === "read_only") {
		return request.capability === "fs.read" &&
			(!request.path || pathWithin(context.approvedCwd, request.path))
			? {
					id: "routine-read-only",
					capability: "fs.read",
					tool: request.tool,
				}
			: null;
	}
	if (context.mode === "full_access") {
		return {
			id: "routine-full-access",
			capability: request.capability,
			tool: request.tool,
		};
	}
	for (const grant of context.grants) {
		if (grant.capability !== request.capability) continue;
		if (grant.tool && grant.tool !== request.tool) continue;
		if (grant.expiresAt && grant.expiresAt <= nowEpochSeconds) continue;
		if (grant.maxUsesPerRun && (grant.usesThisRun ?? 0) >= grant.maxUsesPerRun)
			continue;
		if (grant.path && request.path !== resolve(request.cwd, grant.path))
			continue;
		if (
			grant.pathPrefix &&
			(!request.path ||
				!pathWithin(resolve(request.cwd, grant.pathPrefix), request.path))
		)
			continue;
		if (grant.command && grant.command !== request.command) continue;
		if (!scalarInputMatches(grant.input, request.input)) continue;
		return grant;
	}
	return null;
}

export async function authorizeRoutineCapability(options: {
	context: RoutinePermissionContext;
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	toolUseId: string;
}): Promise<{ allowed: boolean; reason: string; grant?: RoutineGrant }> {
	const request = normalizeRoutineCapability(options);
	if (!request) {
		const reason = `${options.tool} cannot be preapproved for unattended runs`;
		options.context.actionRequired = { tool: options.tool, reason };
		await options.context.onActionRequired?.(reason);
		return { allowed: false, reason };
	}
	const grant = matchRoutineGrant(options.context, request);
	if (!grant) {
		const detail = request.command
			? `command ${JSON.stringify(request.command)}`
			: request.path
				? `path ${JSON.stringify(request.path)}`
				: undefined;
		const reason = `No Routine grant matches ${request.capability} via ${options.tool}${detail ? ` for ${detail}` : ""}`;
		options.context.actionRequired ??= {
			tool: options.tool,
			reason,
			capability: request,
		};
		await options.context.onActionRequired?.(reason, request);
		return { allowed: false, reason };
	}
	grant.usesThisRun = (grant.usesThisRun ?? 0) + 1;
	await options.context.onGrantUsed?.(grant, request, options.toolUseId);
	return {
		allowed: true,
		reason: `Preapproved by Routine grant ${grant.id}`,
		grant,
	};
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, stable(child)]),
		);
	}
	return value;
}

export function routineAuthorizationFingerprint(
	definition: RoutineDefinition,
): string {
	const withoutGrantIds = {
		...definition,
		grants: definition.grants.map(({ id: _id, ...grant }) => grant),
	};
	return createHash("sha256")
		.update(JSON.stringify(stable(withoutGrantIds)))
		.digest("hex");
}

export function grantsWithIds(
	grants: RoutinePermissionGrantInput[],
): RoutineGrant[] {
	// Every permission-profile revision owns distinct immutable grant rows. IDs
	// supplied by the prior revision are display/audit identities, not reusable
	// primary keys for the new snapshot.
	return grants.map((grant) => ({ ...grant, id: randomUUID() }));
}
