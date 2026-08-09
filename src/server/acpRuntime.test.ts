import { describe, expect, it, vi } from "vitest";
import { HlidConfigSchema } from "../config";
import type { AcpCatalogItem } from "./acpRegistry";
import {
	acpRuntimeFingerprint,
	createConfiguredAcpProvider,
	syncAcpRuntimeProviders,
} from "./acpRuntime";
import type { AgentProvider } from "./agentProvider";

function config(agents: Array<{ id: string; executable?: string }> = []) {
	return HlidConfigSchema.parse({
		vault: { name: "Vault", path: "/workspace" },
		acp_agents: agents,
	});
}

function item(
	id: string,
	options: Partial<AcpCatalogItem> = {},
): AcpCatalogItem {
	return {
		id,
		name: id === "opencode" ? "OpenCode" : id,
		version: "1.0.0",
		description: "agent",
		distribution: {},
		providerId: `acp:${id}`,
		enabled: true,
		available: true,
		command: id,
		args: ["acp"],
		env: {},
		installGuidance: "install it",
		...options,
	};
}

describe("ACP runtime synchronization", () => {
	it("creates a provider from the resolved catalog invocation", () => {
		const provider = createConfiguredAcpProvider(
			item("opencode", { command: "opencode.cmd" }),
			config([{ id: "opencode", executable: "opencode.cmd" }]),
		);
		expect(provider.providerId).toBe("acp:opencode");
		expect(provider.label).toBe("OpenCode");
		expect(provider.modelCatalogScope).toBe("workspace");
		expect(provider.metadataCacheIdentity).toBe(
			acpRuntimeFingerprint(
				item("opencode", { command: "opencode.cmd" }),
				config([{ id: "opencode", executable: "opencode.cmd" }]),
			),
		);
	});

	it("adds, replaces, and removes only managed ACP providers", async () => {
		const native = { providerId: "codex", query: vi.fn() } as AgentProvider;
		const providers = new Map<string, AgentProvider>([["codex", native]]);
		const fingerprints = new Map<string, string>();
		const retire = vi.fn();
		const register = vi.fn();
		const firstConfig = config([{ id: "opencode" }]);
		const firstItem = item("opencode");

		expect(
			await syncAcpRuntimeProviders({
				config: firstConfig,
				catalog: [firstItem],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: ["acp:opencode"], removed: [], replaced: [] });
		expect(providers.get("codex")).toBe(native);
		expect(register).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: "acp:opencode" }),
			false,
		);

		const changedConfig = config([
			{ id: "opencode", executable: "C:/tools/opencode.cmd" },
		]);
		const changedItem = item("opencode", {
			command: "C:/tools/opencode.cmd",
		});
		expect(
			await syncAcpRuntimeProviders({
				config: changedConfig,
				catalog: [changedItem],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: [], replaced: ["acp:opencode"] });
		expect(retire).toHaveBeenLastCalledWith(["acp:opencode"], {
			preserveSelection: true,
		});

		expect(
			await syncAcpRuntimeProviders({
				config: config(),
				catalog: [item("opencode", { enabled: false })],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: ["acp:opencode"], replaced: [] });
		expect(retire).toHaveBeenLastCalledWith(["acp:opencode"]);
		expect(providers.get("codex")).toBe(native);
		expect(providers.has("acp:opencode")).toBe(false);
	});

	it("does not replace an unchanged provider", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		const register = vi.fn();

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [activeItem],
				providers,
				fingerprints,
				retireProviderSessions: vi.fn(),
				registerProvider: register,
			}),
		).toEqual({ added: [], removed: [], replaced: [] });
		expect(providers.get(provider.providerId)).toBe(provider);
		expect(register).not.toHaveBeenCalled();
	});

	it("does not replace a live provider only because registry availability changed", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const availableItem = item("opencode");
		const provider = createConfiguredAcpProvider(availableItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(availableItem, activeConfig)],
		]);
		const retire = vi.fn();

		expect(
			await syncAcpRuntimeProviders({
				config: activeConfig,
				catalog: [
					item("opencode", {
						available: false,
						unavailableReason: "temporary PATH lookup timeout",
					}),
				],
				providers,
				fingerprints,
				retireProviderSessions: retire,
				registerProvider: vi.fn(),
			}),
		).toEqual({ added: [], removed: [], replaced: [] });
		expect(retire).not.toHaveBeenCalled();
		expect(providers.get(provider.providerId)).toBe(provider);
	});

	it("waits for retired runtime cleanup before registering its replacement", async () => {
		const activeConfig = config([{ id: "opencode" }]);
		const activeItem = item("opencode");
		const provider = createConfiguredAcpProvider(activeItem, activeConfig);
		const providers = new Map<string, AgentProvider>([
			[provider.providerId, provider],
		]);
		const fingerprints = new Map([
			[provider.providerId, acpRuntimeFingerprint(activeItem, activeConfig)],
		]);
		let finishCleanup: () => void = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const register = vi.fn();
		const changedConfig = config([
			{ id: "opencode", executable: "/new/opencode" },
		]);

		const pending = syncAcpRuntimeProviders({
			config: changedConfig,
			catalog: [item("opencode", { command: "/new/opencode" })],
			providers,
			fingerprints,
			retireProviderSessions: () => cleanup,
			registerProvider: register,
		});
		await Promise.resolve();
		expect(register).not.toHaveBeenCalled();
		expect(providers.has("acp:opencode")).toBe(false);

		finishCleanup();
		await expect(pending).resolves.toEqual({
			added: [],
			removed: [],
			replaced: ["acp:opencode"],
		});
		expect(register).toHaveBeenCalledOnce();
		expect(providers.has("acp:opencode")).toBe(true);
	});
});
