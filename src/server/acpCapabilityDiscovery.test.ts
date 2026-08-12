import type {
	InitializeResponse,
	SessionConfigOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAcpProviderCapabilities } from "./acpCapabilityDiscovery";

afterEach(() => vi.useRealTimers());

function selectOption(input: {
	id: string;
	name: string;
	category: string;
	values: Array<{ value: string; name: string }>;
	currentValue?: string;
}): SessionConfigOption {
	return {
		type: "select",
		id: input.id,
		name: input.name,
		category: input.category,
		currentValue: input.currentValue ?? input.values[0]?.value ?? "",
		options: input.values,
	};
}

function evidenceBySuffix(
	initialized: InitializeResponse,
	configOptions: SessionConfigOption[] = [],
	modes?: SessionModeState,
) {
	const discovery = discoverAcpProviderCapabilities({
		providerId: "acp:opencode",
		cwd: "C:\\workspace",
		initialized,
		configOptions,
		modes,
	});
	return {
		discovery,
		get(suffix: string) {
			const evidence = discovery.evidence.find((item) =>
				item.id.endsWith(suffix),
			);
			expect(evidence, suffix).toBeDefined();
			return evidence;
		},
	};
}

describe("ACP provider capability discovery", () => {
	it("separates integrated ACP controls from advertised but unintegrated features", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
		const initialized = {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					list: {},
					delete: {},
					additionalDirectories: {},
					fork: {},
					resume: {},
					close: {},
				},
				promptCapabilities: {
					image: true,
					audio: true,
					embeddedContext: true,
				},
				mcpCapabilities: { http: true, sse: true, acp: true },
			},
			authMethods: [{ id: "login", name: "Login" }],
		} satisfies InitializeResponse;
		const configOptions = [
			selectOption({
				id: "model",
				name: "Model",
				category: "model",
				values: [
					{ value: "one", name: "One" },
					{ value: "two", name: "Two" },
				],
			}),
			selectOption({
				id: "mode",
				name: "Mode",
				category: "mode",
				values: [
					{ value: "build", name: "Build" },
					{ value: "plan", name: "Plan" },
				],
			}),
			selectOption({
				id: "effort",
				name: "Reasoning effort",
				category: "thought_level",
				values: [
					{ value: "low", name: "Low" },
					{ value: "high", name: "High" },
				],
			}),
		];

		const { discovery, get } = evidenceBySuffix(initialized, configOptions);

		expect(discovery).toMatchObject({
			observedAt: Date.parse("2026-08-09T12:00:00Z"),
			context: { cwd: "C:\\workspace" },
		});
		expect(get("acp-session:baseline")).toMatchObject({
			integration: "integrated",
			operations: ["new", "prompt", "cancel", "update"],
		});
		for (const method of [
			"load",
			"resume",
			"close",
			"delete",
			"additional-directories",
			"fork",
		]) {
			expect(get(`acp-session:${method}`)).toMatchObject({
				support: "advertised",
				integration: "integrated",
				readiness: "ready",
			});
		}
		expect(get("acp-session:fork")?.maturity).toBe("experimental");
		expect(get("acp-session:list")).toMatchObject({
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
		});
		for (const kind of ["image", "embedded-context"]) {
			expect(get(`acp-prompt:${kind}`)).toMatchObject({
				support: "advertised",
				integration: "integrated",
				readiness: "ready",
			});
		}
		expect(get("acp-prompt:audio")).toMatchObject({
			support: "advertised",
			integration: "not-integrated",
			readiness: "unavailable",
		});
		for (const transport of ["http", "sse"]) {
			expect(get(`acp-mcp-transport:${transport}`)).toMatchObject({
				support: "advertised",
				integration: "integrated",
			});
		}
		expect(get("acp-mcp-transport:acp")).toMatchObject({
			integration: "not-integrated",
			maturity: "experimental",
		});
		expect(get("acp-auth:credential-actions")).toMatchObject({
			label: "Credential actions (1)",
			integration: "integrated",
			readiness: "ready",
		});
		expect(get("acp-auth:sign-in-status")).toMatchObject({
			support: "unknown",
			integration: "provider-native",
			readiness: "unknown",
		});
		expect(get("acp-session-config:model")).toMatchObject({
			label: "Model configuration (2)",
			integration: "integrated",
		});
		expect(get("acp-session-config:mode")).toMatchObject({
			label: "Session mode configuration (2)",
			integration: "integrated",
		});
		expect(get("acp-session-config:effort")).toMatchObject({
			label: "Reasoning effort configuration (2)",
			integration: "integrated",
		});
	});

	it("retains unavailable evidence when an agent advertises no optional capabilities", () => {
		const { discovery, get } = evidenceBySuffix({ protocolVersion: 1 });

		expect(discovery.evidence).toHaveLength(19);
		expect(get("acp-session:baseline")?.readiness).toBe("ready");
		for (const suffix of [
			"acp-session:load",
			"acp-session:resume",
			"acp-session:list",
			"acp-prompt:image",
			"acp-mcp-transport:http",
			"acp-auth:credential-actions",
			"acp-session-config:model",
		]) {
			expect(get(suffix)?.support).toBe("not-advertised");
			expect(get(suffix)?.readiness).toBe("unavailable");
		}
		expect(get("acp-auth:sign-in-status")?.support).toBe("unknown");
	});

	it("integrates arbitrary select modes but not boolean config options", () => {
		const { get } = evidenceBySuffix({ protocolVersion: 1 }, [
			selectOption({
				id: "mode",
				name: "Mode",
				category: "mode",
				values: [
					{ value: "review", name: "Review" },
					{ value: "research", name: "Research" },
				],
			}),
			{
				type: "boolean",
				id: "model-toggle",
				name: "Model toggle",
				category: "model",
				currentValue: true,
			},
			{
				type: "boolean",
				id: "effort-toggle",
				name: "Effort toggle",
				category: "thought_level",
				currentValue: true,
			},
		]);

		expect(get("acp-session-config:mode")).toMatchObject({
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
		});
		for (const kind of ["model", "effort"]) {
			expect(get(`acp-session-config:${kind}`)).toMatchObject({
				support: "advertised",
				integration: "not-integrated",
				readiness: "unavailable",
			});
		}
	});

	it("integrates legacy ACP session modes when no stable mode option is advertised", () => {
		const { get } = evidenceBySuffix({ protocolVersion: 1 }, [], {
			currentModeId: "code",
			availableModes: [
				{ id: "code", name: "Code" },
				{ id: "plan", name: "Plan" },
			],
		});

		expect(get("acp-session-config:mode")).toMatchObject({
			label: "Session mode configuration (2)",
			support: "advertised",
			integration: "integrated",
			readiness: "ready",
			operations: ["list", "select"],
		});
	});

	it("bounds configuration option and select-value evidence", () => {
		const values = Array.from({ length: 250 }, (_, index) => ({
			value: `model-${index}`,
			name: `Model ${index}`,
		}));
		const options = [
			selectOption({
				id: "model",
				name: "Model",
				category: "model",
				values,
			}),
			...Array.from({ length: 100 }, (_, index) => ({
				type: "boolean" as const,
				id: `custom-${index}`,
				name: `Custom ${index}`,
				category: "_custom",
				currentValue: false,
			})),
		];

		const { discovery, get } = evidenceBySuffix(
			{ protocolVersion: 1 },
			options,
		);

		expect(get("acp-session-config:model")?.label).toBe(
			"Model configuration (200)",
		);
		expect(discovery.issues).toEqual([
			"ACP returned more than 100 session configuration options; capability evidence was truncated.",
			"ACP model configuration exceeded 200 values; capability evidence was truncated.",
		]);
	});
});
