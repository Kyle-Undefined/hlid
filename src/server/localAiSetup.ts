import type { HlidConfig } from "#/config";
import { getSetting, saveSetting } from "#/db/settings";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import {
	LOCAL_AI_SETUP_SETTING_KEY,
	type LocalAiSetupIntent,
	LocalAiSetupIntentSchema,
	type LocalAiSetupMutation,
	type LocalAiSetupSnapshot,
	type LocalAiSetupStep,
} from "#/lib/localAiSetup";
import { loadConfig } from "./config";

type LiveOllama = {
	supported: boolean;
	available: boolean;
	setupPhase: string | null;
	models: string[];
	firewallReady: boolean | null;
};

type LiveOpenCode = { available: boolean };

export type LocalAiSetupDependencies = {
	getSetting: typeof getSetting;
	saveSetting: typeof saveSetting;
	loadConfig: () => HlidConfig;
	readOllama: () => Promise<LiveOllama>;
	readOpenCode: () => Promise<LiveOpenCode>;
	now: () => number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function readOllama(): Promise<LiveOllama> {
	const response = await requireDbOk(
		await dbFetch("/ollama"),
		"inspect Ollama",
	);
	const body = asRecord(await response.json());
	if (!body || typeof body.supported !== "boolean") {
		throw new Error("Ollama status response was malformed");
	}
	const status = asRecord(body.status);
	const setup = asRecord(body.setup);
	const firewall = asRecord(body.firewall);
	const models = Array.isArray(body.models)
		? body.models.flatMap((model) => {
				const item = asRecord(model);
				return typeof item?.model === "string" ? [item.model] : [];
			})
		: [];
	return {
		supported: body.supported,
		available: status?.available === true,
		setupPhase: typeof setup?.phase === "string" ? setup.phase : null,
		models,
		firewallReady: typeof firewall?.exact === "boolean" ? firewall.exact : null,
	};
}

async function readOpenCode(): Promise<LiveOpenCode> {
	const response = await requireDbOk(
		await dbFetch("/acp/registry?refresh=1"),
		"inspect OpenCode ACP",
	);
	const body = asRecord(await response.json());
	const agent = Array.isArray(body?.agents)
		? body.agents.map(asRecord).find((item) => item?.id === "opencode")
		: undefined;
	if (!agent || typeof agent.available !== "boolean") {
		throw new Error("OpenCode ACP status response was malformed");
	}
	return { available: agent.available };
}

const defaultDependencies: LocalAiSetupDependencies = {
	getSetting,
	saveSetting,
	loadConfig,
	readOllama,
	readOpenCode,
	now: Date.now,
};

function readIntent(raw: string | null): LocalAiSetupIntent | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return LocalAiSetupIntentSchema.safeParse(parsed).data ?? null;
	} catch {
		return null;
	}
}

function openCodeConfig(config: HlidConfig) {
	return config.acp_agents?.find((agent) => agent.id === "opencode");
}

function step(
	intent: LocalAiSetupIntent | null,
	id: LocalAiSetupStep["id"],
	title: string,
	description: string,
	status: LocalAiSetupStep["status"],
	action: LocalAiSetupStep["action"],
): LocalAiSetupStep {
	return {
		id,
		title,
		description,
		status,
		action,
		acknowledged: intent?.acknowledged.includes(id) ?? false,
	};
}

export function createLocalAiSetupCoordinator(
	dependencies: LocalAiSetupDependencies = defaultDependencies,
) {
	async function snapshot(): Promise<LocalAiSetupSnapshot> {
		const [rawIntent, ollamaResult, openCodeResult] = await Promise.all([
			dependencies.getSetting(LOCAL_AI_SETUP_SETTING_KEY),
			dependencies.readOllama().then(
				(value) => ({ value }),
				() => ({ value: null }),
			),
			dependencies.readOpenCode().then(
				(value) => ({ value }),
				() => ({ value: null }),
			),
		]);
		const intent = readIntent(rawIntent);
		const config = dependencies.loadConfig();
		const configuredOpenCode = openCodeConfig(config);
		const selectedModels = config.ollama?.models ?? [];
		const target = configuredOpenCode?.target?.kind;
		const ollama = ollamaResult.value;
		const openCode = openCodeResult.value;
		const present = ollama?.models ?? null;
		const allSelectedPresent =
			selectedModels.length > 0 &&
			present !== null &&
			selectedModels.every((model) => present.includes(model));
		const wslAccessRequired = target === "wsl";

		return {
			intent,
			live: {
				ollama: {
					supported: ollama?.supported ?? false,
					available: ollama ? ollama.available : null,
					setupPhase: ollama?.setupPhase ?? null,
				},
				openCode: {
					configured: Boolean(configuredOpenCode),
					available: openCode?.available ?? null,
					target:
						target === "wsl" ? "wsl" : configuredOpenCode ? "windows" : null,
				},
				models: { selected: selectedModels, present },
				wslAccessRequired,
				firewallReady: wslAccessRequired
					? (ollama?.firewallReady ?? null)
					: null,
			},
			steps: [
				step(
					intent,
					"ollama",
					"Windows Ollama",
					ollama?.available
						? "Windows Ollama is responding."
						: "Inspect or install Ollama in its existing Windows setup flow.",
					ollama?.available ? "ready" : ollama ? "needs-action" : "unknown",
					"ollama",
				),
				step(
					intent,
					"opencode",
					"OpenCode ACP",
					configuredOpenCode
						? openCode?.available
							? "OpenCode is configured and currently available."
							: "OpenCode is configured, but its live ACP status needs attention."
						: "Choose and confirm an OpenCode ACP target in the existing ACP setup flow.",
					configuredOpenCode && openCode?.available
						? "ready"
						: openCode || configuredOpenCode
							? "needs-action"
							: "unknown",
					"opencode",
				),
				step(
					intent,
					"models",
					"Local models",
					allSelectedPresent
						? "Selected local models are present in Windows Ollama."
						: "Select or download models in the existing Ollama flow; downloads are never started here.",
					allSelectedPresent
						? "ready"
						: present === null
							? "unknown"
							: "needs-action",
					"ollama",
				),
				step(
					intent,
					"wsl-access",
					"WSL access",
					!wslAccessRequired
						? "Not needed while OpenCode uses the Windows target."
						: ollama?.firewallReady
							? "The narrow Hlid WSL relay firewall rule is ready."
							: "If Windows asks, confirm the existing narrow firewall action in Ollama settings.",
					!wslAccessRequired
						? "not-needed"
						: ollama?.firewallReady
							? "ready"
							: ollama
								? "needs-action"
								: "unknown",
					"ollama",
				),
			],
		};
	}

	async function mutate(
		input: LocalAiSetupMutation,
	): Promise<LocalAiSetupSnapshot> {
		const now = Math.floor(dependencies.now());
		const current = readIntent(
			await dependencies.getSetting(LOCAL_AI_SETUP_SETTING_KEY),
		);
		const intent: LocalAiSetupIntent =
			input.action === "start"
				? {
						version: 1,
						startedAt: current?.startedAt ?? now,
						acknowledged: current?.acknowledged ?? [],
						updatedAt: now,
					}
				: {
						version: 1,
						startedAt: current?.startedAt ?? now,
						acknowledged: [
							...new Set([...(current?.acknowledged ?? []), input.step]),
						],
						updatedAt: now,
					};
		await dependencies.saveSetting(
			LOCAL_AI_SETUP_SETTING_KEY,
			JSON.stringify(intent),
		);
		return snapshot();
	}

	return { snapshot, mutate };
}

// fallow-ignore-next-line unused-export -- The API route loads this server-only coordinator dynamically to keep it out of the client bundle.
export const localAiSetup = createLocalAiSetupCoordinator();
