import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { z } from "zod";
import {
	type AcpExecutionTarget,
	AcpExecutionTargetSchema,
	acpExecutionTargetKey,
} from "#/lib/acpExecutionTarget";
import type {
	AcpManagedMutationAction,
	AcpManagedOperationPhase,
	AcpManagedOperationSnapshot,
} from "#/lib/acpManagedTypes";
import { writeFileAtomic } from "#/lib/atomicFile";
import { parseWslUncSyntax } from "#/lib/paths";
import { assertSafeAcpCmdShimInvocation } from "./acpExecutable";
import {
	type AcpManagedFetcher,
	classifyAcpManagedArchive,
	downloadVerifiedAcpArchive,
	extractAcpManagedArchive,
	normalizeAcpManagedCommand,
} from "./acpManagedArchive";
import { acpExecutionTargetId } from "./acpTargets";

const MANAGED_STATE_SCHEMA_VERSION = 1;
const RECEIPT_FILENAME = ".hlid-acp-receipt.json";
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PLATFORM_TARGETS = new Set([
	"linux-x86_64",
	"linux-aarch64",
	"windows-x86_64",
	"windows-aarch64",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;

export type AcpManagedRegistryInvocationLike = {
	cmd: string;
	args?: string[];
	env?: Record<string, string>;
	archive?: string;
	sha256?: string;
};

export type AcpManagedRegistryAgentLike = {
	id: string;
	name: string;
	version: string;
	distribution: {
		binary?: Record<string, AcpManagedRegistryInvocationLike>;
	};
};

export type AcpManagedTargetDescriptor = {
	targetId: string;
	target: AcpExecutionTarget;
	label: string;
	cwd: string;
	recommended: boolean;
};

export type AcpManagedInvocation = {
	agentId: string;
	target: AcpExecutionTarget;
	command: string;
	args: string[];
	env: Record<string, string>;
	installedVersion: string;
	observedVersion?: string;
};

export type AcpManagedTargetClaim = {
	agentId: string;
	target: AcpExecutionTarget;
	targetId: string;
	hostCwd: string;
};

export type AcpManagedRecordStatus = AcpManagedInvocation & {
	usable: boolean;
	error?: string;
};

export type AcpManagedInstallSupport = {
	supported: boolean;
	blockedReason?: string;
	updateAvailable?: boolean;
};

export type AcpManagedTargetState = {
	operation?: AcpManagedOperationSnapshot;
	error?: string;
};

export type AcpManagedProbeInput = {
	agentId: string;
	target: AcpExecutionTarget;
	command: string;
	args: string[];
	env: Record<string, string>;
	hostCwd: string;
	signal: AbortSignal;
};

export type AcpManagedInstallDependencies = {
	toTargetPath(input: {
		hostPath: string;
		target: AcpExecutionTarget;
		hostCwd: string;
	}): string;
	probe(input: AcpManagedProbeInput): Promise<{ observedVersion?: string }>;
	/** Re-read catalog state and reconcile live runtimes after exact-target mutation. */
	refresh(): Promise<void>;
	fetcher?: AcpManagedFetcher;
	now?: () => number;
	randomUUID?: () => string;
};

export type AcpManagedMutationInput = {
	action: AcpManagedMutationAction;
	agent: AcpManagedRegistryAgentLike;
	targetDescriptor: AcpManagedTargetDescriptor;
	platformTarget: string;
	enabled: boolean;
};

export type AcpManagedMutationJob = {
	operation: AcpManagedOperationSnapshot;
	completion: Promise<void>;
};

const RecordSchema = z
	.object({
		agentId: z.string().regex(AGENT_ID_RE),
		target: AcpExecutionTargetSchema,
		targetId: z.string().regex(TARGET_ID_RE),
		registryVersion: z.string().min(1).max(256),
		archiveSha256: z.string().regex(SHA256_RE),
		commandRelativePath: z.string().min(1).max(1_024),
		command: z.string().min(1).max(4_096),
		hostCwd: z.string().min(1).max(32_768),
		args: z.array(z.string()),
		env: z.record(z.string(), z.string()),
		versionDirectoryName: z
			.string()
			.regex(/^version-[a-f0-9]{32}-[a-f0-9]{64}-[a-f0-9]{32}$/),
		observedVersion: z.string().min(1).max(256).optional(),
		installedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((record, context) => {
		const issue = targetClaimValidationError(record);
		if (issue) context.addIssue({ code: "custom", message: issue });
	});

export type AcpManagedInstallRecord = z.infer<typeof RecordSchema>;

const StateSchema = z
	.object({
		schemaVersion: z.literal(MANAGED_STATE_SCHEMA_VERSION),
		installs: z.array(RecordSchema),
		retired: z.array(RecordSchema).default([]),
	})
	.strict();

type AcpManagedInstallState = z.infer<typeof StateSchema>;

type SelectedDistribution = {
	archive: string;
	sha256: string;
	commandRelativePath: string;
	args: string[];
	env: Record<string, string>;
	archiveKind: "tar-gzip" | "zip" | "raw";
};

type ActiveOperation = {
	key: string;
	claim: AcpManagedTargetClaim;
	snapshot: AcpManagedOperationSnapshot;
	controller: AbortController;
};

function recordKey(agentId: string, target: AcpExecutionTarget): string {
	return `${agentId}\0${acpExecutionTargetKey(target)}`;
}

function stableEnvironment(value: Record<string, string>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
}

function safeAgentId(agentId: string): string {
	if (!AGENT_ID_RE.test(agentId)) throw new Error("ACP agent id is invalid");
	return agentId;
}

function targetStorageKey(target: AcpExecutionTarget): string {
	return `target-${createHash("sha256")
		.update(acpExecutionTargetKey(target))
		.digest("hex")
		.slice(0, 32)}`;
}

function agentStorageKey(agentId: string): string {
	return `agent-${createHash("sha256")
		.update(safeAgentId(agentId))
		.digest("hex")
		.slice(0, 32)}`;
}

function distributionMetadataFingerprint(
	commandRelativePath: string,
	args: string[],
	env: Record<string, string>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				commandRelativePath,
				args,
				env: stableEnvironment(env),
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

function versionDirectoryName(
	version: string,
	sha256: string,
	commandRelativePath: string,
	args: string[],
	env: Record<string, string>,
): string {
	return `version-${createHash("sha256")
		.update(version)
		.digest("hex")
		.slice(0, 32)}-${sha256}-${distributionMetadataFingerprint(
		commandRelativePath,
		args,
		env,
	)}`;
}

function recordMatchesDistribution(
	record: AcpManagedInstallRecord,
	version: string,
	distribution: SelectedDistribution,
): boolean {
	return (
		record.registryVersion === version &&
		record.archiveSha256 === distribution.sha256 &&
		record.commandRelativePath === distribution.commandRelativePath &&
		JSON.stringify(record.args) === JSON.stringify(distribution.args) &&
		stableEnvironment(record.env) === stableEnvironment(distribution.env)
	);
}

function cloneTarget(target: AcpExecutionTarget): AcpExecutionTarget {
	return target.kind === "host"
		? { kind: "host" }
		: { kind: "wsl", distro: target.distro };
}

function targetCommandIsAbsolute(
	command: string,
	target: AcpExecutionTarget,
): boolean {
	return target.kind === "wsl"
		? posix.isAbsolute(command)
		: isAbsolute(command) || win32.isAbsolute(command);
}

function targetClaimValidationError(
	claim: AcpManagedTargetClaim,
): string | null {
	if (!AGENT_ID_RE.test(claim.agentId)) return "ACP agent id is invalid";
	if (claim.targetId !== acpExecutionTargetId(claim.target)) {
		return "Managed ACP target id does not match its exact target";
	}
	if (claim.target.kind === "host") {
		const hasControlCharacter = [...claim.hostCwd].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 0x20 || code === 0x7f;
		});
		if (
			hasControlCharacter ||
			(!isAbsolute(claim.hostCwd) && !win32.isAbsolute(claim.hostCwd))
		) {
			return "Managed ACP working directory is not an absolute host path";
		}
		return null;
	}
	const cwd = parseWslUncSyntax(claim.hostCwd);
	if (!cwd || cwd.distro.toLowerCase() !== claim.target.distro.toLowerCase()) {
		return "Managed ACP working directory does not match its WSL target";
	}
	return null;
}

function cloneClaim(claim: AcpManagedTargetClaim): AcpManagedTargetClaim {
	return {
		agentId: claim.agentId,
		target: cloneTarget(claim.target),
		targetId: claim.targetId,
		hostCwd: claim.hostCwd,
	};
}

function cloneOperation(
	operation: AcpManagedOperationSnapshot,
): AcpManagedOperationSnapshot {
	return { ...operation };
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message || "Managed ACP operation failed").slice(0, 500);
}

function stateWithUniqueRecords(value: unknown): AcpManagedInstallState {
	const state = StateSchema.parse(value);
	const keys = new Set<string>();
	const versionKeys = new Set<string>();
	for (const record of state.installs) {
		const key = recordKey(record.agentId, record.target);
		if (keys.has(key))
			throw new Error("managed ACP state has duplicate records");
		keys.add(key);
		versionKeys.add(`${key}\0${record.versionDirectoryName}`);
	}
	for (const record of state.retired) {
		const key = `${recordKey(record.agentId, record.target)}\0${record.versionDirectoryName}`;
		if (versionKeys.has(key)) {
			throw new Error("managed ACP state has duplicate version records");
		}
		versionKeys.add(key);
	}
	return state;
}

function emptyState(): AcpManagedInstallState {
	return {
		schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
		installs: [],
		retired: [],
	};
}

async function assertManagedDirectoryChain(
	root: string,
	directory: string,
): Promise<void> {
	const within = relative(root, directory);
	if (within.startsWith("..") || isAbsolute(within)) {
		throw new Error("Managed ACP storage path escaped its root");
	}
	const rootMetadata = await lstat(root).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		},
	);
	if (rootMetadata?.isSymbolicLink()) {
		throw new Error("Managed ACP storage contains a symbolic link");
	}
	if (rootMetadata && !rootMetadata.isDirectory()) {
		throw new Error("Managed ACP storage root is not a directory");
	}
	let current = root;
	for (const component of within ? within.split(/[\\/]/) : []) {
		current = join(current, component);
		const metadata = await lstat(current).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			},
		);
		if (metadata?.isSymbolicLink()) {
			throw new Error("Managed ACP storage contains a symbolic link");
		}
		if (metadata && !metadata.isDirectory()) {
			throw new Error("Managed ACP storage path is not a directory");
		}
	}
}

function managedDirectoryChainIsSafe(root: string, directory: string): boolean {
	const within = relative(root, directory);
	if (within.startsWith("..") || isAbsolute(within)) return false;
	let current = root;
	for (const component of within ? within.split(/[\\/]/) : []) {
		current = join(current, component);
		const metadata = lstatSync(current);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
	}
	return true;
}

function selectedDistribution(
	agent: AcpManagedRegistryAgentLike,
	target: AcpExecutionTarget,
	platformTarget: string,
): { value?: SelectedDistribution; blockedReason?: string } {
	const expectedPlatformPrefix = target.kind === "host" ? "windows-" : "linux-";
	if (
		!PLATFORM_TARGETS.has(platformTarget) ||
		!platformTarget.startsWith(expectedPlatformPrefix)
	) {
		return {
			blockedReason: `Managed installation does not support ${platformTarget} for this target`,
		};
	}
	const invocation = agent.distribution.binary?.[platformTarget];
	if (!invocation) {
		return {
			blockedReason: `No official binary is published for ${platformTarget}`,
		};
	}
	const archive = invocation.archive?.trim();
	const sha256 = invocation.sha256?.trim().toLowerCase();
	if (!archive || !sha256 || !SHA256_RE.test(sha256)) {
		return {
			blockedReason:
				"The official binary does not include an exact archive and SHA-256 digest",
		};
	}
	const archiveKind = classifyAcpManagedArchive(archive);
	if (!archiveKind) {
		return {
			blockedReason:
				"The official binary format is not supported by the managed installer",
		};
	}
	let archiveFilename = "";
	try {
		archiveFilename =
			decodeURIComponent(new URL(archive).pathname).split("/").at(-1) ?? "";
	} catch {
		// classifyAcpManagedArchive already rejected malformed URLs.
	}
	if (target.kind === "wsl" && /\.exe$/i.test(archiveFilename)) {
		return {
			blockedReason:
				"Windows executable distributions cannot be installed into WSL",
		};
	}
	let commandRelativePath: string;
	try {
		commandRelativePath = normalizeAcpManagedCommand(invocation.cmd, {
			windowsPaths: target.kind === "host",
		});
		if (target.kind === "host" && /\.(?:bat|cmd)$/i.test(commandRelativePath)) {
			assertSafeAcpCmdShimInvocation(
				commandRelativePath,
				invocation.args ?? [],
			);
		}
	} catch {
		return {
			blockedReason: "The official binary command path or arguments are unsafe",
		};
	}
	return {
		value: {
			archive,
			sha256,
			commandRelativePath,
			args: [...(invocation.args ?? [])],
			env: { ...(invocation.env ?? {}) },
			archiveKind,
		},
	};
}

export class AcpManagedInstaller {
	private readonly root: string;
	private readonly statePath: string;
	private readonly now: () => number;
	private readonly uuid: () => string;
	private state: AcpManagedInstallState;
	private stateError: string | undefined;
	private active: ActiveOperation | null = null;
	private readonly failures = new Map<string, string>();

	constructor(
		root: string,
		private readonly dependencies: AcpManagedInstallDependencies,
	) {
		this.root = resolve(root);
		this.statePath = join(this.root, "managed.json");
		this.now = dependencies.now ?? Date.now;
		this.uuid = dependencies.randomUUID ?? randomUUID;
		try {
			if (existsSync(this.root)) {
				const rootMetadata = lstatSync(this.root);
				if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
					throw new Error("Managed ACP storage root is unsafe");
				}
			}
			if (
				existsSync(this.statePath) &&
				lstatSync(this.statePath).isSymbolicLink()
			) {
				throw new Error("Managed ACP state is a symbolic link");
			}
			this.state = this.readState();
		} catch (error) {
			this.state = emptyState();
			this.stateError = errorMessage(error);
		}
	}

	private readState(): AcpManagedInstallState {
		if (!existsSync(this.statePath)) return emptyState();
		try {
			return stateWithUniqueRecords(
				JSON.parse(readFileSync(this.statePath, "utf8")),
			);
		} catch (error) {
			throw new Error(`Managed ACP state is invalid: ${errorMessage(error)}`);
		}
	}

	private async writeState(state: AcpManagedInstallState): Promise<void> {
		const validated = stateWithUniqueRecords(state);
		await writeFileAtomic(
			this.statePath,
			`${JSON.stringify(validated, null, 2)}\n`,
			{ mode: 0o600 },
		);
		this.state = validated;
		this.stateError = undefined;
	}

	private findRecord(
		agentId: string,
		target: AcpExecutionTarget,
	): AcpManagedInstallRecord | undefined {
		const key = recordKey(agentId, target);
		return this.state.installs.find(
			(record) => recordKey(record.agentId, record.target) === key,
		);
	}

	private targetRoot(agentId: string, target: AcpExecutionTarget): string {
		return join(
			this.root,
			"targets",
			targetStorageKey(target),
			agentStorageKey(agentId),
		);
	}

	private versionDirectory(record: AcpManagedInstallRecord): string {
		return join(
			this.targetRoot(record.agentId, record.target),
			"versions",
			record.versionDirectoryName,
		);
	}

	private hostExecutable(record: AcpManagedInstallRecord): string {
		return join(
			this.versionDirectory(record),
			...record.commandRelativePath.split("/"),
		);
	}

	private recordFilesAreUsable(record: AcpManagedInstallRecord): boolean {
		try {
			const versionDirectory = this.versionDirectory(record);
			const executable = this.hostExecutable(record);
			if (
				record.versionDirectoryName !==
					versionDirectoryName(
						record.registryVersion,
						record.archiveSha256,
						record.commandRelativePath,
						record.args,
						record.env,
					) ||
				!managedDirectoryChainIsSafe(this.root, versionDirectory)
			) {
				return false;
			}
			const rootReal = realpathSync(versionDirectory);
			const executableReal = realpathSync(executable);
			const within = relative(rootReal, executableReal);
			if (!within || within.startsWith("..") || isAbsolute(within))
				return false;
			const metadata = lstatSync(executable);
			if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
			const expectedCommand = this.dependencies.toTargetPath({
				hostPath: executable,
				target: record.target,
				hostCwd: record.hostCwd,
			});
			if (
				expectedCommand !== record.command ||
				!targetCommandIsAbsolute(expectedCommand, record.target)
			) {
				return false;
			}
			const receiptPath = join(versionDirectory, RECEIPT_FILENAME);
			const receiptMetadata = lstatSync(receiptPath);
			if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()) {
				return false;
			}
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
			return (
				typeof receipt === "object" &&
				receipt !== null &&
				(receipt as { archiveSha256?: unknown }).archiveSha256 ===
					record.archiveSha256 &&
				(receipt as { commandRelativePath?: unknown }).commandRelativePath ===
					record.commandRelativePath &&
				(receipt as { agentId?: unknown }).agentId === record.agentId &&
				(receipt as { registryVersion?: unknown }).registryVersion ===
					record.registryVersion &&
				JSON.stringify((receipt as { target?: unknown }).target) ===
					JSON.stringify(record.target) &&
				(receipt as { targetId?: unknown }).targetId === record.targetId &&
				(receipt as { hostCwd?: unknown }).hostCwd === record.hostCwd &&
				JSON.stringify((receipt as { args?: unknown }).args) ===
					JSON.stringify(record.args) &&
				typeof (receipt as { env?: unknown }).env === "object" &&
				(receipt as { env?: unknown }).env !== null &&
				stableEnvironment((receipt as { env: Record<string, string> }).env) ===
					stableEnvironment(record.env)
			);
		} catch {
			return false;
		}
	}

	// fallow-ignore-next-line unused-class-member -- Vitest inspects declarative state copies without exposing the mutable internal state.
	records(): AcpManagedInstallRecord[] {
		return this.state.installs.map((record) => ({
			...record,
			target: cloneTarget(record.target),
			args: [...record.args],
			env: { ...record.env },
		}));
	}

	/** Narrow exact claims that config mutation and remove-only recovery retain. */
	// fallow-ignore-next-line unused-class-member -- Called through AcpManagedCatalogSource after the installer is attached to AcpRegistry.
	claimedTargets(): AcpManagedTargetClaim[] {
		const claims = new Map<string, AcpManagedTargetClaim>();
		for (const record of this.state.installs) {
			const claim = cloneClaim(record);
			claims.set(recordKey(claim.agentId, claim.target), claim);
		}
		for (const record of this.state.retired) {
			const claim = cloneClaim(record);
			claims.set(recordKey(claim.agentId, claim.target), claim);
		}
		if (this.active) {
			const claim = cloneClaim(this.active.claim);
			claims.set(recordKey(claim.agentId, claim.target), claim);
		}
		return [...claims.values()];
	}

	// fallow-ignore-next-line unused-class-member -- Called through AcpManagedCatalogSource after the manager is attached to AcpRegistry.
	resolveManagedInvocation(
		agentId: string,
		target: AcpExecutionTarget,
	): AcpManagedInvocation | null {
		const status = this.managedRecord(agentId, target);
		if (!status?.usable) return null;
		const { usable: _usable, error: _error, ...invocation } = status;
		return invocation;
	}

	managedRecord(
		agentId: string,
		target: AcpExecutionTarget,
	): AcpManagedRecordStatus | null {
		const record =
			this.findRecord(agentId, target) ??
			this.state.retired.find(
				(item) =>
					recordKey(item.agentId, item.target) === recordKey(agentId, target),
			);
		if (!record) return null;
		const active = this.findRecord(agentId, target) === record;
		const usable = active && this.recordFilesAreUsable(record);
		return {
			agentId: record.agentId,
			target: cloneTarget(record.target),
			command: record.command,
			args: [...record.args],
			env: { ...record.env },
			installedVersion: record.registryVersion,
			...(record.observedVersion
				? { observedVersion: record.observedVersion }
				: {}),
			usable,
			...(usable
				? {}
				: {
						error: active
							? "Managed ACP files are missing or failed validation"
							: "Managed ACP files are retained only for cleanup",
					}),
		};
	}

	// fallow-ignore-next-line unused-class-member -- Called through AcpManagedCatalogSource while registry snapshots overlay live operation state.
	targetState(
		agentId: string,
		target: AcpExecutionTarget,
	): AcpManagedTargetState {
		const key = recordKey(agentId, target);
		const recordError = this.managedRecord(agentId, target)?.error;
		return {
			...(this.active?.key === key
				? { operation: cloneOperation(this.active.snapshot) }
				: {}),
			...(this.stateError
				? { error: this.stateError }
				: this.failures.has(key)
					? { error: this.failures.get(key) }
					: recordError
						? { error: recordError }
						: {}),
		};
	}

	// fallow-ignore-next-line unused-class-member -- Called through AcpManagedCatalogSource to derive server-owned target actions.
	installSupport(
		agent: AcpManagedRegistryAgentLike,
		target: AcpExecutionTarget,
		platformTarget: string,
	): AcpManagedInstallSupport {
		if (this.stateError) {
			return { supported: false, blockedReason: this.stateError };
		}
		if (!AGENT_ID_RE.test(agent.id)) {
			return { supported: false, blockedReason: "ACP agent id is invalid" };
		}
		const selected = selectedDistribution(agent, target, platformTarget);
		const current = this.findRecord(agent.id, target);
		if (
			!current &&
			this.state.retired.some(
				(record) =>
					recordKey(record.agentId, record.target) ===
					recordKey(agent.id, target),
			)
		) {
			return {
				supported: false,
				blockedReason:
					"Managed ACP files are retained for cleanup and must be removed first",
			};
		}
		return selected.value
			? {
					supported: true,
					...(current
						? {
								updateAvailable:
									!this.recordFilesAreUsable(current) ||
									!recordMatchesDistribution(
										current,
										agent.version,
										selected.value,
									),
							}
						: {}),
				}
			: { supported: false, blockedReason: selected.blockedReason };
	}

	// fallow-ignore-next-line unused-class-member -- Called through the narrowed AcpRouteDependencies managed-installer boundary.
	mutate(input: AcpManagedMutationInput): AcpManagedMutationJob {
		if (this.active) throw new Error("Another managed ACP operation is active");
		if (this.stateError) throw new Error(this.stateError);
		const agentId = safeAgentId(input.agent.id);
		if (!TARGET_ID_RE.test(input.targetDescriptor.targetId)) {
			throw new Error("ACP target id is invalid");
		}
		const target = AcpExecutionTargetSchema.parse(
			input.targetDescriptor.target,
		);
		const claim: AcpManagedTargetClaim = {
			agentId,
			target: cloneTarget(target),
			targetId: input.targetDescriptor.targetId,
			hostCwd: input.targetDescriptor.cwd,
		};
		const claimError = targetClaimValidationError(claim);
		if (claimError) throw new Error(claimError);
		const key = recordKey(agentId, target);
		const current = this.findRecord(agentId, target);
		const retired = this.state.retired.filter(
			(record) => recordKey(record.agentId, record.target) === key,
		);
		let selected: SelectedDistribution | undefined;
		if (input.action === "remove") {
			if (!current && retired.length === 0) {
				throw new Error("This managed ACP agent is not installed");
			}
			if (input.enabled) {
				throw new Error(
					"Disable this ACP agent before removing its managed files",
				);
			}
		} else {
			const result = selectedDistribution(
				input.agent,
				target,
				input.platformTarget,
			);
			if (!result.value) throw new Error(result.blockedReason);
			selected = result.value;
			if (input.action === "install" && retired.length > 0) {
				throw new Error(
					"Managed ACP files are retained for cleanup and must be removed first",
				);
			}
			if (input.action === "install" && current) {
				throw new Error("This managed ACP agent is already installed");
			}
			if (input.action === "update" && !current) {
				throw new Error("This managed ACP agent is not installed");
			}
			if (
				input.action === "update" &&
				current &&
				this.recordFilesAreUsable(current) &&
				recordMatchesDistribution(current, input.agent.version, selected)
			) {
				throw new Error("This managed ACP agent is already current");
			}
		}

		const controller = new AbortController();
		const operation: ActiveOperation = {
			key,
			claim,
			controller,
			snapshot: {
				id: this.uuid(),
				action: input.action,
				phase: "queued",
				cancelable: input.action !== "remove",
			},
		};
		this.failures.delete(key);
		this.active = operation;
		const completion = Promise.resolve()
			.then(async () => {
				await this.retryRetiredVersions(1);
				return input.action === "remove"
					? this.remove(operation, current, retired)
					: this.installOrUpdate(
							input,
							operation,
							selected as SelectedDistribution,
							current,
						);
			})
			.catch((error) => {
				this.failures.set(key, errorMessage(error));
				throw error;
			})
			.finally(() => {
				if (this.active === operation) this.active = null;
			});
		return { operation: cloneOperation(operation.snapshot), completion };
	}

	// fallow-ignore-next-line unused-class-member -- Retained as the manager cancellation boundary and exercised directly by lifecycle tests.
	cancel(operationId: string): boolean {
		if (
			!this.active ||
			this.active.snapshot.id !== operationId ||
			!this.active.snapshot.cancelable
		) {
			return false;
		}
		this.active.controller.abort(new Error("Managed ACP operation cancelled"));
		return true;
	}

	private phase(
		operation: ActiveOperation,
		phase: AcpManagedOperationPhase,
	): void {
		operation.snapshot.phase = phase;
		operation.snapshot.cancelable = ![
			"activating",
			"refreshing",
			"removing",
		].includes(phase);
		if (phase !== "downloading") {
			delete operation.snapshot.received;
			delete operation.snapshot.total;
		}
	}

	private async installOrUpdate(
		input: AcpManagedMutationInput,
		operation: ActiveOperation,
		distribution: SelectedDistribution,
		prior: AcpManagedInstallRecord | undefined,
	): Promise<void> {
		const { agent, targetDescriptor } = input;
		const target = targetDescriptor.target;
		const targetRoot = this.targetRoot(agent.id, target);
		const stage = join(targetRoot, "staging", operation.snapshot.id);
		const archivePath = join(stage, "archive.part");
		const payloadPath = join(stage, "payload");
		const stagingRoot = join(targetRoot, "staging");
		const versionsRoot = join(targetRoot, "versions");
		const candidateDirectoryName = versionDirectoryName(
			agent.version,
			distribution.sha256,
			distribution.commandRelativePath,
			distribution.args,
			distribution.env,
		);
		const versionDirectory = join(versionsRoot, candidateDirectoryName);
		let stageCreated = false;
		let createdVersion = false;
		try {
			await assertManagedDirectoryChain(this.root, targetRoot);
			await mkdir(targetRoot, { recursive: true, mode: 0o700 });
			await assertManagedDirectoryChain(this.root, targetRoot);
			await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
			await assertManagedDirectoryChain(this.root, stagingRoot);
			if (existsSync(stage)) {
				throw new Error("Managed ACP staging directory already exists");
			}
			await mkdir(stage, { mode: 0o700 });
			stageCreated = true;
			await assertManagedDirectoryChain(this.root, stage);
			this.phase(operation, "downloading");
			await downloadVerifiedAcpArchive({
				url: distribution.archive,
				sha256: distribution.sha256,
				destination: archivePath,
				signal: operation.controller.signal,
				fetcher: this.dependencies.fetcher,
				onProgress: ({ received, total }) => {
					operation.snapshot.received = received;
					operation.snapshot.total = total;
				},
				onVerifying: () => this.phase(operation, "verifying"),
			});
			this.phase(operation, "extracting");
			const extracted = await extractAcpManagedArchive({
				archivePath,
				archiveKind: distribution.archiveKind,
				destination: payloadPath,
				command: distribution.commandRelativePath,
				windowsPaths: target.kind === "host",
				signal: operation.controller.signal,
			});
			await writeFile(
				join(payloadPath, RECEIPT_FILENAME),
				`${JSON.stringify({
					schemaVersion: 1,
					agentId: agent.id,
					registryVersion: agent.version,
					archiveSha256: distribution.sha256,
					commandRelativePath: extracted.commandRelativePath,
					target,
					targetId: targetDescriptor.targetId,
					hostCwd: targetDescriptor.cwd,
					args: distribution.args,
					env: distribution.env,
				})}\n`,
				{ encoding: "utf8", mode: 0o600, flag: "wx" },
			);
			await mkdir(versionsRoot, {
				recursive: true,
				mode: 0o700,
			});
			await assertManagedDirectoryChain(this.root, versionsRoot);
			if (existsSync(versionDirectory)) {
				if (prior?.versionDirectoryName === candidateDirectoryName) {
					if (this.recordFilesAreUsable(prior)) {
						throw new Error(
							"Managed ACP candidate conflicts with the active version",
						);
					}
				}
				await this.removeDerivedEntry(versionsRoot, versionDirectory);
			}
			await rename(payloadPath, versionDirectory);
			createdVersion = true;
			await this.verifyVersionDirectory(
				versionDirectory,
				distribution.sha256,
				distribution.commandRelativePath,
			);

			const hostExecutable = join(
				versionDirectory,
				...distribution.commandRelativePath.split("/"),
			);
			const command = this.dependencies.toTargetPath({
				hostPath: hostExecutable,
				target,
				hostCwd: targetDescriptor.cwd,
			});
			if (!targetCommandIsAbsolute(command, target)) {
				throw new Error(
					"Managed ACP executable is not an absolute target path",
				);
			}
			this.phase(operation, "probing");
			const probe = await this.dependencies.probe({
				agentId: agent.id,
				target,
				command,
				args: distribution.args,
				env: distribution.env,
				hostCwd: targetDescriptor.cwd,
				signal: operation.controller.signal,
			});
			const record: AcpManagedInstallRecord = {
				agentId: agent.id,
				target: cloneTarget(target),
				targetId: targetDescriptor.targetId,
				registryVersion: agent.version,
				archiveSha256: distribution.sha256,
				commandRelativePath: distribution.commandRelativePath,
				command,
				hostCwd: targetDescriptor.cwd,
				args: [...distribution.args],
				env: { ...distribution.env },
				versionDirectoryName: candidateDirectoryName,
				...(probe.observedVersion
					? { observedVersion: probe.observedVersion }
					: {}),
				installedAt: this.now(),
			};
			const next = this.replaceRecord(record, prior);
			this.phase(operation, "activating");
			await this.writeState(next);
			this.phase(operation, "refreshing");
			try {
				await this.dependencies.refresh();
			} catch (error) {
				await this.rollbackState(prior, record);
				throw new Error(`Managed ACP refresh failed: ${errorMessage(error)}`);
			}
			if (prior && prior.versionDirectoryName !== candidateDirectoryName) {
				// A running Windows process can briefly retain the old executable. Keep
				// the retired version in durable state until bounded cleanup succeeds.
				await this.retryRetiredRecord(prior, 3);
			}
		} catch (error) {
			if (
				createdVersion &&
				this.findRecord(agent.id, target)?.versionDirectoryName !==
					candidateDirectoryName
			) {
				await this.removeDerivedEntry(versionsRoot, versionDirectory).catch(
					() => {},
				);
			}
			throw error;
		} finally {
			if (stageCreated) {
				await this.removeDerivedEntry(stagingRoot, stage).catch(() => {});
			}
		}
	}

	private replaceRecord(
		record: AcpManagedInstallRecord,
		prior: AcpManagedInstallRecord | undefined,
	): AcpManagedInstallState {
		const key = recordKey(record.agentId, record.target);
		const candidateVersionKey = `${key}\0${record.versionDirectoryName}`;
		const retired = this.state.retired.filter(
			(item) =>
				`${recordKey(item.agentId, item.target)}\0${item.versionDirectoryName}` !==
				candidateVersionKey,
		);
		if (prior && prior.versionDirectoryName !== record.versionDirectoryName) {
			retired.push(prior);
		}
		return {
			schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
			installs: [
				...this.state.installs.filter(
					(item) => recordKey(item.agentId, item.target) !== key,
				),
				record,
			],
			retired,
		};
	}

	private async rollbackState(
		prior: AcpManagedInstallRecord | undefined,
		failed: AcpManagedInstallRecord,
	): Promise<void> {
		const failedKey = recordKey(failed.agentId, failed.target);
		const installs = this.state.installs.filter(
			(record) => recordKey(record.agentId, record.target) !== failedKey,
		);
		if (prior) installs.push(prior);
		const restoredVersionKey = prior
			? `${failedKey}\0${prior.versionDirectoryName}`
			: null;
		await this.writeState({
			schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
			installs,
			retired: this.state.retired.filter(
				(record) =>
					`${recordKey(record.agentId, record.target)}\0${record.versionDirectoryName}` !==
					restoredVersionKey,
			),
		});
		await this.dependencies.refresh().catch(() => {});
	}

	private async verifyVersionDirectory(
		versionDirectory: string,
		archiveSha256: string,
		commandRelativePath: string,
	): Promise<void> {
		const rootReal = await realpath(versionDirectory);
		const executable = join(
			versionDirectory,
			...commandRelativePath.split("/"),
		);
		const executableReal = await realpath(executable);
		const within = relative(rootReal, executableReal);
		if (!within || within.startsWith("..") || isAbsolute(within)) {
			throw new Error("Existing managed ACP version directory is unsafe");
		}
		const metadata = await lstat(executable);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Existing managed ACP executable is unsafe");
		}
		const receipt = JSON.parse(
			await readFile(join(versionDirectory, RECEIPT_FILENAME), "utf8"),
		) as { archiveSha256?: unknown; commandRelativePath?: unknown };
		if (
			receipt.archiveSha256 !== archiveSha256 ||
			receipt.commandRelativePath !== commandRelativePath
		) {
			throw new Error("Existing managed ACP version receipt does not match");
		}
	}

	private async removeVersionDirectory(
		record: AcpManagedInstallRecord,
	): Promise<void> {
		const { directory, versionsRoot } =
			await this.validateVersionRemoval(record);
		await this.removeDerivedEntry(versionsRoot, directory);
	}

	private async validateVersionRemoval(
		record: AcpManagedInstallRecord,
	): Promise<{ directory: string; versionsRoot: string }> {
		const directory = this.versionDirectory(record);
		const versionsRoot = join(
			this.targetRoot(record.agentId, record.target),
			"versions",
		);
		const within = relative(versionsRoot, directory);
		if (!within || within.startsWith("..") || isAbsolute(within)) {
			throw new Error("Managed ACP version path is unsafe");
		}
		await assertManagedDirectoryChain(this.root, versionsRoot);
		return { directory, versionsRoot };
	}

	private async removeDerivedEntry(
		parent: string,
		directory: string,
	): Promise<void> {
		const within = relative(parent, directory);
		if (!within || within.startsWith("..") || isAbsolute(within)) {
			throw new Error("Managed ACP cleanup path is unsafe");
		}
		await assertManagedDirectoryChain(this.root, parent);
		const metadata = await lstat(directory).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			},
		);
		if (!metadata) return;
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
			await unlink(directory);
			return;
		}
		await rm(directory, { recursive: true, force: true });
	}

	private async retryRetiredRecord(
		record: AcpManagedInstallRecord,
		attempts: number,
	): Promise<void> {
		const versionKey = `${recordKey(record.agentId, record.target)}\0${record.versionDirectoryName}`;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const stillRetired = this.state.retired.some(
				(item) =>
					`${recordKey(item.agentId, item.target)}\0${item.versionDirectoryName}` ===
					versionKey,
			);
			if (!stillRetired) return;
			try {
				await this.removeVersionDirectory(record);
				await this.writeState({
					schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
					installs: this.state.installs,
					retired: this.state.retired.filter(
						(item) =>
							`${recordKey(item.agentId, item.target)}\0${item.versionDirectoryName}` !==
							versionKey,
					),
				});
				return;
			} catch {
				if (attempt + 1 < attempts) {
					const retryDelayMs = attempt === 0 ? 25 : 100;
					await new Promise<void>((resolveRetry) => {
						setTimeout(resolveRetry, retryDelayMs);
					});
				}
			}
		}
	}

	private async retryRetiredVersions(attempts: number): Promise<void> {
		for (const record of [...this.state.retired]) {
			await this.retryRetiredRecord(record, attempts);
		}
	}

	private async restoreRemovedRecord(
		record: AcpManagedInstallRecord,
		retired: AcpManagedInstallRecord[],
		phase: "refresh" | "cleanup",
		error: unknown,
	): Promise<never> {
		await this.writeState({
			schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
			installs: [...this.state.installs, record],
			retired: [...this.state.retired, ...retired],
		});
		await this.dependencies.refresh().catch(() => {});
		throw new Error(`Managed ACP ${phase} failed: ${errorMessage(error)}`);
	}

	private async restoreRetiredRecords(
		retired: AcpManagedInstallRecord[],
	): Promise<void> {
		await this.writeState({
			schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
			installs: this.state.installs,
			retired: [...this.state.retired, ...retired],
		});
		await this.dependencies.refresh().catch(() => {});
	}

	private async remove(
		operation: ActiveOperation,
		record: AcpManagedInstallRecord | undefined,
		retired: AcpManagedInstallRecord[],
	): Promise<void> {
		this.phase(operation, "removing");
		// Delete obsolete payloads first. If Windows still has one locked, the
		// active executable remains intact and can be restored after the failure.
		const removalRecords = [...retired, ...(record ? [record] : [])];
		for (const removalRecord of removalRecords) {
			await this.validateVersionRemoval(removalRecord);
		}
		const claim = operation.claim;
		const key = recordKey(claim.agentId, claim.target);
		const next: AcpManagedInstallState = {
			schemaVersion: MANAGED_STATE_SCHEMA_VERSION,
			installs: this.state.installs.filter(
				(item) => recordKey(item.agentId, item.target) !== key,
			),
			retired: this.state.retired.filter(
				(item) => recordKey(item.agentId, item.target) !== key,
			),
		};
		await this.writeState(next);
		this.phase(operation, "refreshing");
		try {
			await this.dependencies.refresh();
		} catch (error) {
			if (record) {
				await this.restoreRemovedRecord(record, retired, "refresh", error);
			}
			await this.restoreRetiredRecords(retired);
			throw new Error(`Managed ACP refresh failed: ${errorMessage(error)}`);
		}
		try {
			for (const removalRecord of removalRecords) {
				await this.removeVersionDirectory(removalRecord);
			}
		} catch (error) {
			if (record) {
				await this.restoreRemovedRecord(record, retired, "cleanup", error);
			}
			await this.restoreRetiredRecords(retired);
			throw new Error(`Managed ACP cleanup failed: ${errorMessage(error)}`);
		}
	}
}
