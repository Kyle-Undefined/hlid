import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type {
	AgentEntry,
	AgentProviderSettings,
} from "#/components/einherjar/AgentCard";
import type { Agent } from "#/config";

const VALID_EFFORTS: string[] = ["low", "medium", "high", "xhigh", "max"];
const VALID_PERMISSION_MODES: string[] = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
];

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

/** Owns the einherjar agent list state and its CRUD operations against the server config. */
export function useAgentRoster({
	initialAgents,
	saveAgentsFn,
	validateAgentPathFn,
	getAgentsFn,
}: {
	initialAgents: AgentEntry[];
	saveAgentsFn: (opts: { data: Agent[] }) => Promise<void>;
	validateAgentPathFn: (opts: { data: string }) => Promise<{
		dirExists: boolean;
		inVault: boolean;
		externalAllowed: boolean;
		suggestedName: string;
	}>;
	getAgentsFn: () => Promise<AgentEntry[]>;
}) {
	const router = useRouter();
	const [agents, setAgents] = useState<AgentEntry[]>(initialAgents);

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
			instructionFile: null,
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
	}

	return { agents, handleRemove, handleModeChange, handleSaveEdit, handleAdd };
}
