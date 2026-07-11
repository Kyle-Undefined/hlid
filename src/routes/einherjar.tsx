import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AddAgentPanel } from "#/components/einherjar/AddAgentPanel";
import type {
	AgentEntry,
	AgentProviderSettings,
} from "#/components/einherjar/AgentCard";
import { AgentCard, AgentEmptyState } from "#/components/einherjar/AgentCard";
import type { Agent } from "#/config";
import { getConfig } from "#/config";
import { writeConfig } from "#/lib/config-writer";
import { expandTilde, samePath } from "#/lib/paths";
import { agentListSchema, agentPathSchema } from "#/lib/serverFnSchemas";
import type { ProviderInfo } from "#/lib/serverFns";
import { getProvidersFn } from "#/lib/serverFns";
import { uid } from "#/lib/utils";

const VALID_EFFORTS: string[] = ["low", "medium", "high", "xhigh", "max"];
const VALID_PERMISSION_MODES: string[] = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
];

// ─── server fns ──────────────────────────────────────────────────────────────

function deriveAgentName(p: string): string {
	return basename(p)
		.split(/[-_\s]+/)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

const getAgentsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<AgentEntry[]> => {
		const config = await getConfig();
		return (config.agents ?? []).map((agent) => {
			const resolved = expandTilde(agent.path);
			return {
				path: agent.path,
				name: agent.name ?? deriveAgentName(resolved),
				mode: agent.mode ?? "cwd",
				provider: agent.provider ?? "claude",
				hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
				dirExists: existsSync(resolved),
				model: agent.model,
				effort: agent.effort,
				maxTurns:
					agent.max_turns !== undefined ? String(agent.max_turns) : undefined,
				permissionMode: agent.permission_mode,
				recapModel: agent.recap_model,
				interactiveMode: agent.interactive_mode,
			};
		});
	},
);

const validateAgentPathFn = createServerFn({ method: "GET" })
	.validator((raw) => agentPathSchema.parse(raw))
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		const resolved = resolve(expandTilde(agentPath));
		const vaultPath = config.vault.path
			? resolve(expandTilde(config.vault.path))
			: "";
		let inVault = false;
		if (vaultPath) {
			const rel = relative(vaultPath, resolved);
			inVault =
				samePath(resolved, vaultPath) ||
				(!rel.startsWith("..") && !isAbsolute(rel));
		}
		return {
			dirExists: existsSync(resolved),
			hasClaudemd: existsSync(join(resolved, "CLAUDE.md")),
			suggestedName: deriveAgentName(resolved),
			inVault,
			externalAllowed: config.server.allow_external_agents,
			resolvedPath: resolved,
		};
	});

const saveAgentsFn = createServerFn({ method: "POST" })
	.validator((raw) => agentListSchema.parse(raw))
	.handler(async ({ data: agentList }) => {
		const config = await getConfig();
		writeConfig({ ...config, agents: agentList });
	});

const readClaudemdFn = createServerFn({ method: "GET" })
	.validator((raw) => agentPathSchema.parse(raw))
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested)))
			throw new Error("Unauthorized");
		const claudemdPath = join(requested, "CLAUDE.md");
		if (!existsSync(claudemdPath)) return null;
		return readFileSync(claudemdPath, "utf-8");
	});

const getExternalAllowedFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		return config.server.allow_external_agents;
	},
);

// ─── route ───────────────────────────────────────────────────────────────────

type LoaderData = {
	agents: AgentEntry[];
	externalAllowed: boolean;
	providers: ProviderInfo[];
};

export const Route = createFileRoute("/einherjar")({
	loader: async (): Promise<LoaderData> => {
		const [agents, externalAllowed, providers] = await Promise.all([
			getAgentsFn(),
			getExternalAllowedFn(),
			getProvidersFn(),
		]);
		return { agents, externalAllowed, providers };
	},
	component: EinherjarPage,
});

// ─── component ───────────────────────────────────────────────────────────────

function EinherjarPage() {
	const {
		agents: initialAgents,
		externalAllowed,
		providers,
	} = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();

	const [agents, setAgents] = useState<AgentEntry[]>(initialAgents);
	const [showAdd, setShowAdd] = useState(false);

	function agentEntryToConfig(a: AgentEntry): Agent {
		return {
			path: a.path,
			name: a.name,
			mode: a.mode,
			provider: a.provider,
			model: a.model || undefined,
			effort:
				a.effort != null && VALID_EFFORTS.includes(a.effort)
					? (a.effort as Agent["effort"])
					: undefined,
			max_turns: (() => {
				const parsed = parseInt(a.maxTurns ?? "", 10);
				return !Number.isNaN(parsed) ? parsed : undefined;
			})(),
			permission_mode:
				a.permissionMode != null &&
				VALID_PERMISSION_MODES.includes(a.permissionMode)
					? (a.permissionMode as Agent["permission_mode"])
					: undefined,
			recap_model: a.recapModel || undefined,
			interactive_mode: a.interactiveMode || undefined,
		};
	}

	async function handleRemove(path: string) {
		const next = agents.filter((a) => a.path !== path);
		await saveAgentsFn({ data: next.map(agentEntryToConfig) });
		setAgents(next);
		await router.invalidate();
	}

	async function handleModeChange(path: string, mode: "cwd" | "context") {
		const prevAgents = agents;
		const next = agents.map((a) => (a.path === path ? { ...a, mode } : a));
		setAgents(next);
		try {
			await saveAgentsFn({ data: next.map(agentEntryToConfig) });
			await router.invalidate();
		} catch {
			setAgents(prevAgents);
		}
	}

	async function handleSaveEdit(
		originalPath: string,
		name: string,
		mode: "cwd" | "context",
		provider: string,
		settings: AgentProviderSettings,
	) {
		const prevAgents = agents;
		const next = agents.map((a) =>
			a.path === originalPath ? { ...a, name, mode, provider, ...settings } : a,
		);
		setAgents(next);
		try {
			await saveAgentsFn({ data: next.map(agentEntryToConfig) });
			await router.invalidate();
		} catch {
			setAgents(prevAgents);
			throw new Error("Failed to save");
		}
	}

	async function handleAdd(
		path: string,
		name: string,
		mode: "cwd" | "context",
		provider: string,
		settings: AgentProviderSettings,
	) {
		if (agents.some((a) => a.path === path)) {
			throw new Error("Agent already added");
		}
		const validation = await validateAgentPathFn({ data: path });
		if (!validation.dirExists) {
			throw new Error("Directory not found");
		}
		if (!validation.inVault && !validation.externalAllowed) {
			throw new Error(
				"Directory outside vault. Enable 'Allow external agents' in Server settings.",
			);
		}
		const resolvedName = name || validation.suggestedName;
		const newEntry: AgentEntry = {
			path,
			name: resolvedName,
			mode,
			provider,
			hasClaudemd: false,
			dirExists: true,
			...settings,
		};
		const next: Agent[] = [
			...agents.map(agentEntryToConfig),
			agentEntryToConfig(newEntry),
		];
		await saveAgentsFn({ data: next });
		await router.invalidate();
		const refreshed = await getAgentsFn();
		setAgents(refreshed);
		setShowAdd(false);
	}

	function handleChat(agent: AgentEntry) {
		void navigate({
			to: "/raven",
			search: { session: uid(), agent: agent.path },
		});
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto p-5 space-y-6">
				{/* Header */}
				<div className="flex items-center justify-between">
					<div>
						<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
							Einherjar
						</div>
						<div className="text-[9px] tracking-widest text-muted-foreground/40 mt-0.5">
							chosen warriors · vault agents
						</div>
					</div>
					<button
						type="button"
						onClick={() => setShowAdd((v) => !v)}
						className="flex items-center gap-1.5 text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
					>
						<Plus className="w-3 h-3" />
						ADD
					</button>
				</div>

				{/* Add form */}
				{showAdd && (
					<AddAgentPanel
						externalAllowed={externalAllowed}
						onAdd={handleAdd}
						onCancel={() => setShowAdd(false)}
						providers={providers}
					/>
				)}

				{/* Agent list */}
				<div className="border border-border bg-card divide-y divide-border/50">
					{agents.length === 0 ? (
						<AgentEmptyState />
					) : (
						agents.map((agent) => (
							<AgentCard
								key={agent.path}
								agent={agent}
								onRemove={() => void handleRemove(agent.path)}
								onModeChange={(mode) => void handleModeChange(agent.path, mode)}
								onChat={() => handleChat(agent)}
								onSaveEdit={(name, mode, provider, settings) =>
									handleSaveEdit(agent.path, name, mode, provider, settings)
								}
								onReadClaudemd={() => readClaudemdFn({ data: agent.path })}
								providers={providers}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}
