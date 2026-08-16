import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpExecutionTarget } from "#/lib/acpExecutionTarget";
import type { AcpManagedMutationAction } from "#/lib/acpManagedTypes";
import {
	type AcpManagedInstallDependencies,
	AcpManagedInstaller,
	type AcpManagedRegistryAgentLike,
	type AcpManagedTargetDescriptor,
} from "./acpManagedInstall";
import { acpExecutionTargetId } from "./acpTargets";

const temporaryDirectories: string[] = [];
const target: AcpExecutionTarget = { kind: "wsl", distro: "Ubuntu-24.04" };
const descriptor: AcpManagedTargetDescriptor = {
	targetId: acpExecutionTargetId(target),
	target,
	label: "WSL · Ubuntu-24.04",
	cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\vault",
	recommended: true,
};
const hostTarget: AcpExecutionTarget = { kind: "host" };
const hostDescriptor: AcpManagedTargetDescriptor = {
	targetId: acpExecutionTargetId(hostTarget),
	target: hostTarget,
	label: "Windows",
	cwd: "C:\\Users\\Kyle\\vault",
	recommended: false,
};
const expectedClaim = {
	agentId: "opencode",
	target,
	targetId: descriptor.targetId,
	hostCwd: descriptor.cwd,
};

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "hlid-acp-install-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function agent(
	version: string,
	payload: Buffer,
	overrides: Partial<AcpManagedRegistryAgentLike> = {},
): AcpManagedRegistryAgentLike {
	return {
		id: "opencode",
		name: "OpenCode",
		version,
		distribution: {
			binary: {
				"linux-x86_64": {
					archive: `https://releases.example/opencode-${version}`,
					sha256: createHash("sha256").update(payload).digest("hex"),
					cmd: "./bin/opencode",
					args: ["acp"],
					env: { OPENCODE_MODE: "managed" },
				},
			},
		},
		...overrides,
	};
}

function dependencies(
	payload: Buffer,
	overrides: Partial<AcpManagedInstallDependencies> = {},
): AcpManagedInstallDependencies {
	return {
		toTargetPath: ({ hostPath }) =>
			`/mnt/c/hlid/${hostPath.split(/[\\/]/).slice(-4).join("/")}`,
		probe: vi.fn().mockResolvedValue({ observedVersion: "1.0.0" }),
		refresh: vi.fn().mockResolvedValue(undefined),
		fetcher: vi.fn(
			async () =>
				new Response(new Uint8Array(payload), {
					status: 200,
					headers: { "content-length": String(payload.length) },
				}),
		),
		now: () => 1_800_000_000_000,
		randomUUID: () => "11111111-2222-4333-8444-555555555555",
		...overrides,
	};
}

function mutate(
	installer: AcpManagedInstaller,
	action: AcpManagedMutationAction,
	registryAgent: AcpManagedRegistryAgentLike,
	enabled = false,
) {
	return installer.mutate({
		action,
		agent: registryAgent,
		targetDescriptor: descriptor,
		platformTarget: "linux-x86_64",
		enabled,
	});
}

function mutateHost(
	installer: AcpManagedInstaller,
	action: AcpManagedMutationAction,
	registryAgent: AcpManagedRegistryAgentLike,
	enabled = false,
) {
	return installer.mutate({
		action,
		agent: registryAgent,
		targetDescriptor: hostDescriptor,
		platformTarget: "windows-x86_64",
		enabled,
	});
}

describe("AcpManagedInstaller", () => {
	it("installs a checksummed raw executable for the exact Windows host", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("windows executable");
		const operations = dependencies(payload, {
			toTargetPath: ({ hostPath }) => hostPath,
		});
		const installer = new AcpManagedInstaller(root, operations);
		const windowsAgent = agent("1.0.0", payload);
		windowsAgent.distribution.binary = {
			"windows-x86_64": {
				archive: "https://releases.example/opencode.exe",
				sha256: createHash("sha256").update(payload).digest("hex"),
				cmd: ".\\bin\\opencode.exe",
				args: ["acp"],
			},
		};

		await mutateHost(installer, "install", windowsAgent).completion;
		const invocation = installer.resolveManagedInvocation(
			"opencode",
			hostTarget,
		);
		expect(invocation).toMatchObject({
			target: hostTarget,
			args: ["acp"],
			installedVersion: "1.0.0",
		});
		expect(invocation?.command).toMatch(/bin[/\\]opencode\.exe$/);
		expect(installer.claimedTargets()).toContainEqual({
			agentId: "opencode",
			target: hostTarget,
			targetId: hostDescriptor.targetId,
			hostCwd: hostDescriptor.cwd,
		});
		expect(operations.probe).toHaveBeenCalledWith(
			expect.objectContaining({
				target: hostTarget,
				hostCwd: hostDescriptor.cwd,
			}),
		);
	});

	it("pairs managed Windows hosts and WSL with only their platform families", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		const mixed = agent("1.0.0", payload);
		mixed.distribution.binary = {
			...mixed.distribution.binary,
			"windows-x86_64": {
				archive: "https://releases.example/agent.exe",
				sha256: createHash("sha256").update(payload).digest("hex"),
				cmd: "agent.exe",
			},
		};
		expect(
			installer.installSupport(mixed, hostTarget, "windows-x86_64"),
		).toMatchObject({ supported: true });
		expect(
			installer.installSupport(mixed, hostTarget, "linux-x86_64"),
		).toMatchObject({ supported: false });
		expect(
			installer.installSupport(mixed, target, "windows-x86_64"),
		).toMatchObject({ supported: false });
		const wslExe = agent("1.0.0", payload);
		const wslInvocation = wslExe.distribution.binary?.["linux-x86_64"];
		if (!wslInvocation) throw new Error("expected Linux invocation");
		wslInvocation.archive = "https://releases.example/agent.exe";
		expect(
			installer.installSupport(wslExe, target, "linux-x86_64"),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/Windows executable/),
		});
		wslInvocation.archive = "https://releases.example/agent%2Eexe";
		expect(
			installer.installSupport(wslExe, target, "linux-x86_64"),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/Windows executable/),
		});
	});

	it("rejects unsafe Windows batch shim metadata before download", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("shim");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		const windowsAgent = agent("1.0.0", payload);
		windowsAgent.distribution.binary = {
			"windows-x86_64": {
				archive: "https://releases.example/agent.zip",
				sha256: createHash("sha256").update(payload).digest("hex"),
				cmd: "agent.cmd",
				args: ["acp%PATH%"],
			},
		};
		expect(
			installer.installSupport(windowsAgent, hostTarget, "windows-x86_64"),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/unsafe/),
		});
		expect(() => mutateHost(installer, "install", windowsAgent)).toThrow(
			/unsafe/,
		);
	});

	it("installs a checksummed binary for one exact WSL target and hot refreshes", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("#!/bin/sh\necho opencode\n");
		const operations = dependencies(payload);
		const installer = new AcpManagedInstaller(root, operations);

		const job = mutate(installer, "install", agent("1.0.0", payload));
		expect(job.operation).toMatchObject({
			action: "install",
			phase: "queued",
			cancelable: true,
		});
		await job.completion;

		const invocation = installer.resolveManagedInvocation("opencode", target);
		expect(invocation).toMatchObject({
			target,
			args: ["acp"],
			env: { OPENCODE_MODE: "managed" },
			installedVersion: "1.0.0",
			observedVersion: "1.0.0",
		});
		expect(invocation?.command).toMatch(/^\/mnt\/c\/hlid\//);
		expect(operations.probe).toHaveBeenCalledWith(
			expect.objectContaining({
				target,
				command: invocation?.command,
				hostCwd: descriptor.cwd,
			}),
		);
		expect(operations.refresh).toHaveBeenCalledOnce();
		expect(installer.targetState("opencode", target)).toEqual({});
		const restarted = new AcpManagedInstaller(root, operations);
		expect(restarted.claimedTargets()).toEqual([expectedClaim]);
		const claims = restarted.claimedTargets();
		if (claims[0]?.target.kind === "wsl") {
			claims[0].target.distro = "mutated-copy";
		}
		expect(restarted.claimedTargets()).toEqual([expectedClaim]);
	});

	it("claims the exact target while an install operation is active", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		let release: ((response: Response) => void) | undefined;
		const response = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, {
				fetcher: () => response,
			}),
		);

		const job = mutate(installer, "install", agent("1.0.0", payload));
		expect(installer.records()).toEqual([]);
		expect(installer.claimedTargets()).toEqual([expectedClaim]);
		release?.(new Response(payload));
		await job.completion;
		expect(installer.claimedTargets()).toEqual([expectedClaim]);
	});

	it("keeps the prior version active when an update cannot hot refresh", async () => {
		const root = await temporaryDirectory();
		const firstPayload = Buffer.from("first binary");
		const secondPayload = Buffer.from("second binary");
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("runtime sync failed"))
			.mockResolvedValueOnce(undefined);
		const operations = dependencies(firstPayload, { refresh });
		const installer = new AcpManagedInstaller(root, operations);
		await mutate(installer, "install", agent("1.0.0", firstPayload)).completion;
		const prior = installer.resolveManagedInvocation("opencode", target);
		operations.fetcher = async () => new Response(secondPayload);

		await expect(
			mutate(installer, "update", agent("2.0.0", secondPayload), true)
				.completion,
		).rejects.toThrow(/runtime sync failed/);
		expect(installer.resolveManagedInvocation("opencode", target)).toEqual(
			prior,
		);
		expect(refresh).toHaveBeenNthCalledWith(1);
		expect(refresh).toHaveBeenNthCalledWith(2);
		expect(refresh).toHaveBeenNthCalledWith(3);
		expect(installer.targetState("opencode", target).error).toMatch(
			/runtime sync failed/,
		);
	});

	it("persists an obsolete Windows version for visible cleanup when deletion is locked", async () => {
		const root = await temporaryDirectory();
		const firstPayload = Buffer.from("first executable");
		const secondPayload = Buffer.from("second executable");
		const operations = dependencies(firstPayload, {
			toTargetPath: ({ hostPath }) => hostPath,
		});
		const installer = new AcpManagedInstaller(root, operations);
		const windowsAgent = (version: string, payload: Buffer) => {
			const value = agent(version, payload);
			value.distribution.binary = {
				"windows-x86_64": {
					archive: `https://releases.example/agent-${version}.exe`,
					sha256: createHash("sha256").update(payload).digest("hex"),
					cmd: "agent.exe",
				},
			};
			return value;
		};
		await mutateHost(installer, "install", windowsAgent("1.0.0", firstPayload))
			.completion;
		operations.fetcher = async () => new Response(secondPayload);

		// Simulate a Windows file lock by temporarily replacing cleanup with a
		// failure at the durable retirement boundary.
		const mutableInstaller = installer as unknown as {
			removeVersionDirectory(record: unknown): Promise<void>;
		};
		const originalRemove =
			mutableInstaller.removeVersionDirectory.bind(installer);
		mutableInstaller.removeVersionDirectory = vi
			.fn()
			.mockRejectedValue(new Error("EPERM: executable is locked"));
		await mutateHost(installer, "update", windowsAgent("2.0.0", secondPayload))
			.completion;
		mutableInstaller.removeVersionDirectory = originalRemove;

		expect(
			installer.resolveManagedInvocation("opencode", hostTarget)
				?.installedVersion,
		).toBe("2.0.0");
		const state = JSON.parse(
			await readFile(join(root, "managed.json"), "utf8"),
		) as {
			retired: unknown[];
		};
		expect(state.retired).toHaveLength(1);

		const restarted = new AcpManagedInstaller(root, operations);
		expect(restarted.claimedTargets()).toContainEqual(
			expect.objectContaining({ target: hostTarget }),
		);
		const restartedMutable = restarted as unknown as {
			removeVersionDirectory(record: {
				registryVersion: string;
			}): Promise<void>;
		};
		const restartedRemove =
			restartedMutable.removeVersionDirectory.bind(restarted);
		restartedMutable.removeVersionDirectory = vi.fn(async (record) => {
			if (record.registryVersion === "1.0.0") {
				throw new Error("EPERM: retired executable is locked");
			}
			await restartedRemove(record);
		});
		await expect(
			mutateHost(restarted, "remove", windowsAgent("2.0.0", secondPayload))
				.completion,
		).rejects.toThrow(/retired executable is locked/);
		expect(
			restarted.resolveManagedInvocation("opencode", hostTarget)
				?.installedVersion,
		).toBe("2.0.0");
		restartedMutable.removeVersionDirectory = restartedRemove;
		await mutateHost(restarted, "remove", windowsAgent("2.0.0", secondPayload))
			.completion;
		expect(restarted.claimedTargets()).toEqual([]);
	});

	it("restores an installed record when remove cannot hot refresh", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("remove sync failed"))
			.mockResolvedValueOnce(undefined);
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { refresh }),
		);
		const registryAgent = agent("1.0.0", payload);
		await mutate(installer, "install", registryAgent).completion;
		const prior = installer.resolveManagedInvocation("opencode", target);

		await expect(
			mutate(installer, "remove", registryAgent).completion,
		).rejects.toThrow(/remove sync failed/);
		expect(installer.resolveManagedInvocation("opencode", target)).toEqual(
			prior,
		);
	});

	it("retains an active removal claim until removal completes", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		let releaseRemoval: (() => void) | undefined;
		const removalRefresh = new Promise<void>((resolve) => {
			releaseRemoval = resolve;
		});
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockReturnValueOnce(removalRefresh);
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { refresh }),
		);
		const registryAgent = agent("1.0.0", payload);
		await mutate(installer, "install", registryAgent).completion;

		const removal = mutate(installer, "remove", registryAgent);
		await vi.waitFor(() => expect(installer.records()).toEqual([]));
		expect(installer.claimedTargets()).toEqual([expectedClaim]);
		releaseRemoval?.();
		await removal.completion;
		expect(installer.claimedTargets()).toEqual([]);
	});

	it("updates atomically and removes only after the agent is disabled", async () => {
		const root = await temporaryDirectory();
		const firstPayload = Buffer.from("first binary");
		const secondPayload = Buffer.from("second binary");
		const operations = dependencies(firstPayload);
		const installer = new AcpManagedInstaller(root, operations);
		await mutate(installer, "install", agent("1.0.0", firstPayload)).completion;
		const priorExecutable = installer.records()[0];
		operations.fetcher = async () => new Response(secondPayload);
		await mutate(installer, "update", agent("2.0.0", secondPayload)).completion;
		expect(
			installer.resolveManagedInvocation("opencode", target)?.installedVersion,
		).toBe("2.0.0");
		expect(installer.records()[0]?.versionDirectoryName).not.toBe(
			priorExecutable?.versionDirectoryName,
		);

		expect(() =>
			mutate(installer, "remove", agent("2.0.0", secondPayload), true),
		).toThrow(/Disable/);
		await mutate(installer, "remove", agent("2.0.0", secondPayload)).completion;
		expect(installer.resolveManagedInvocation("opencode", target)).toBeNull();
		expect(installer.records()).toEqual([]);
		expect(installer.claimedTargets()).toEqual([]);
	});

	it("refreshes live runtime evidence after every managed target mutation", async () => {
		const root = await temporaryDirectory();
		const firstPayload = Buffer.from("first binary");
		const secondPayload = Buffer.from("second binary");
		const thirdPayload = Buffer.from("third binary");
		const refresh = vi.fn().mockResolvedValue(undefined);
		const operations = dependencies(firstPayload, { refresh });
		const installer = new AcpManagedInstaller(root, operations);

		await mutate(installer, "install", agent("1.0.0", firstPayload)).completion;
		expect(refresh).toHaveBeenLastCalledWith();

		refresh.mockClear();
		operations.fetcher = async () => new Response(secondPayload);
		await mutate(installer, "update", agent("2.0.0", secondPayload), false)
			.completion;
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenLastCalledWith();

		refresh.mockClear();
		operations.fetcher = async () => new Response(thirdPayload);
		await mutate(installer, "update", agent("3.0.0", thirdPayload), true)
			.completion;
		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenLastCalledWith();
	});

	it("updates same-version distributions when invocation metadata changes", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const operations = dependencies(payload);
		const installer = new AcpManagedInstaller(root, operations);
		const original = agent("1.0.0", payload);
		await mutate(installer, "install", original).completion;
		const originalDirectory = installer.records()[0]?.versionDirectoryName;
		const changed = agent("1.0.0", payload);
		const invocation = changed.distribution.binary?.["linux-x86_64"];
		if (!invocation) throw new Error("expected registry invocation");
		invocation.args = ["acp", "--strict"];

		expect(
			installer.installSupport(changed, target, "linux-x86_64"),
		).toMatchObject({ supported: true, updateAvailable: true });
		await mutate(installer, "update", changed).completion;
		expect(
			installer.resolveManagedInvocation("opencode", target)?.args,
		).toEqual(["acp", "--strict"]);
		expect(installer.records()[0]?.versionDirectoryName).not.toBe(
			originalDirectory,
		);
	});

	it("does not advertise cancellation for queued removals", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		const registryAgent = agent("1.0.0", payload);
		await mutate(installer, "install", registryAgent).completion;

		const job = mutate(installer, "remove", registryAgent);
		expect(job.operation.cancelable).toBe(false);
		expect(installer.cancel(job.operation.id)).toBe(false);
		await job.completion;
	});

	it("keeps a global lock and supports cancellation before activation", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		let release: ((response: Response) => void) | undefined;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { fetcher }),
		);
		const job = mutate(installer, "install", agent("1.0.0", payload));
		expect(() => mutate(installer, "install", agent("1.0.0", payload))).toThrow(
			/Another managed ACP operation/,
		);
		expect(installer.cancel(job.operation.id)).toBe(true);
		release?.(new Response(payload));
		await expect(job.completion).rejects.toThrow(/cancelled/);
		expect(installer.resolveManagedInvocation("opencode", target)).toBeNull();
	});

	it("fails closed on corrupt state without making the server constructor throw", async () => {
		const root = await temporaryDirectory();
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "managed.json"), "{not-json", "utf8");
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		expect(installer.records()).toEqual([]);
		expect(installer.targetState("opencode", target).error).toMatch(
			/state is invalid/,
		);
		expect(() => mutate(installer, "install", agent("1.0.0", payload))).toThrow(
			/state is invalid/,
		);
		expect(
			installer.installSupport(agent("1.0.0", payload), target, "linux-x86_64"),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/state is invalid/),
		});
	});

	it("keeps corrupt managed records visible for repair or removal", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { toTargetPath: ({ hostPath }) => hostPath }),
		);
		await mutate(installer, "install", agent("1.0.0", payload)).completion;
		const invocation = installer.resolveManagedInvocation("opencode", target);
		if (!invocation) throw new Error("expected managed invocation");
		await rm(invocation.command, { force: true });

		expect(installer.resolveManagedInvocation("opencode", target)).toBeNull();
		expect(installer.managedRecord("opencode", target)).toMatchObject({
			usable: false,
			error: expect.stringMatching(/failed validation/),
		});
		expect(installer.targetState("opencode", target).error).toMatch(
			/failed validation/,
		);

		expect(
			installer.installSupport(agent("1.0.0", payload), target, "linux-x86_64"),
		).toMatchObject({ supported: true, updateAvailable: true });
		await mutate(installer, "update", agent("1.0.0", payload)).completion;
		expect(installer.managedRecord("opencode", target)).toMatchObject({
			usable: true,
		});
	});

	it("invalidates a managed record when its receipt claim is changed", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { toTargetPath: ({ hostPath }) => hostPath }),
		);
		await mutate(installer, "install", agent("1.0.0", payload)).completion;
		const invocation = installer.resolveManagedInvocation("opencode", target);
		if (!invocation) throw new Error("expected managed invocation");
		const receiptPath = join(
			dirname(dirname(invocation.command)),
			".hlid-acp-receipt.json",
		);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
			targetId: string;
			hostCwd: string;
		};
		await writeFile(
			receiptPath,
			JSON.stringify({
				...receipt,
				targetId: acpExecutionTargetId({
					kind: "wsl",
					distro: "Other-Distro",
				}),
				hostCwd: "\\\\wsl.localhost\\Other-Distro\\home\\user",
			}),
		);

		expect(installer.resolveManagedInvocation("opencode", target)).toBeNull();
		expect(installer.managedRecord("opencode", target)).toMatchObject({
			usable: false,
		});
	});

	it("replaces a receipt-only orphan with the freshly verified payload", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("trusted binary");
		const pathDependencies = dependencies(payload, {
			toTargetPath: ({ hostPath }) => hostPath,
		});
		const first = new AcpManagedInstaller(root, pathDependencies);
		const registryAgent = agent("1.0.0", payload);
		await mutate(first, "install", registryAgent).completion;
		const firstInvocation = first.resolveManagedInvocation("opencode", target);
		if (!firstInvocation) throw new Error("expected managed invocation");
		await writeFile(firstInvocation.command, "tampered binary");
		await rm(join(root, "managed.json"));

		const replacement = new AcpManagedInstaller(
			root,
			dependencies(payload, { toTargetPath: ({ hostPath }) => hostPath }),
		);
		await mutate(replacement, "install", registryAgent).completion;
		const invocation = replacement.resolveManagedInvocation("opencode", target);
		if (!invocation) throw new Error("expected replacement invocation");
		expect(await readFile(invocation.command)).toEqual(payload);
	});

	it("rejects symbolic links in the managed directory chain", async () => {
		const root = await temporaryDirectory();
		const outside = join(root, "outside");
		await mkdir(outside);
		await symlink(outside, join(root, "targets"), "dir");
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		await expect(
			mutate(installer, "install", agent("1.0.0", payload)).completion,
		).rejects.toThrow(/symbolic link/);
		expect(installer.records()).toEqual([]);
	});

	it("keeps the record when cleanup ancestry becomes a symbolic link", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(
			root,
			dependencies(payload, { toTargetPath: ({ hostPath }) => hostPath }),
		);
		const registryAgent = agent("1.0.0", payload);
		await mutate(installer, "install", registryAgent).completion;
		const invocation = installer.resolveManagedInvocation("opencode", target);
		if (!invocation) throw new Error("expected managed invocation");
		const versionDirectory = dirname(dirname(invocation.command));
		const versionsRoot = dirname(versionDirectory);
		const outside = join(root, "cleanup-outside");
		await mkdir(outside);
		await rm(versionsRoot, { recursive: true });
		await symlink(outside, versionsRoot, "dir");

		await expect(
			mutate(installer, "remove", registryAgent).completion,
		).rejects.toThrow(/symbolic link/);
		expect(installer.records()).toHaveLength(1);
	});

	it("reports unsupported hosts and checksumless registry entries", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(root, dependencies(payload));
		const registryAgent = agent("1.0.0", payload);
		expect(
			installer.installSupport(
				registryAgent,
				{ kind: "host" },
				"windows-x86_64",
			),
		).toMatchObject({ supported: false });
		const binary = registryAgent.distribution.binary?.["linux-x86_64"];
		if (binary) delete binary.sha256;
		expect(
			installer.installSupport(registryAgent, target, "linux-x86_64"),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/SHA-256/),
		});
		expect(
			installer.installSupport(
				agent("1.0.0", payload, { id: ".." }),
				target,
				"linux-x86_64",
			),
		).toMatchObject({
			supported: false,
			blockedReason: expect.stringMatching(/invalid/i),
		});
	});

	it("does not leave a managed record after a checksum failure", async () => {
		const root = await temporaryDirectory();
		const payload = Buffer.from("binary");
		const installer = new AcpManagedInstaller(
			root,
			dependencies(Buffer.from("tampered")),
		);
		await expect(
			mutate(installer, "install", agent("1.0.0", payload)).completion,
		).rejects.toThrow(/checksum/);
		expect(installer.records()).toEqual([]);
		await expect(access(join(root, "managed.json"))).rejects.toThrow();
	});
});
