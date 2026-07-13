import { resolve } from "node:path";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AddAgentPanel } from "#/components/einherjar/AddAgentPanel";
import type {
	AgentEntry,
	AgentProviderSettings,
} from "#/components/einherjar/AgentCard";
import { AgentCard, AgentEmptyState } from "#/components/einherjar/AgentCard";
import { getConfig } from "#/config";
import { readAgentInstructions } from "#/lib/agentInstructions";
import { agentConfigToEntry, inspectAgentPath } from "#/lib/agentMcp";
import { writeConfig } from "#/lib/config-writer";
import { expandTilde, samePath } from "#/lib/paths";
import type { ProviderInfo } from "#/lib/providerTypes";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
import { agentListSchema, agentPathSchema } from "#/lib/serverFnSchemas";
import { getProvidersFn } from "#/lib/serverFns/providers";
import { uid } from "#/lib/utils";
import { useAgentRoster } from "./-useAgentRoster";

// ─── server fns ──────────────────────────────────────────────────────────────

const getAgentsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<AgentEntry[]> => {
		const config = await getConfig();
		return (config.agents ?? []).map(agentConfigToEntry);
	},
);

const validateAgentPathFn = createServerFn({ method: "GET" })
	.validator((raw) => agentPathSchema.parse(raw))
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		return inspectAgentPath(agentPath, config);
	});

const saveAgentsFn = createServerFn({ method: "POST" })
	.validator((raw) => agentListSchema.parse(raw))
	.handler(async ({ data: agentList }) => {
		const config = await getConfig();
		writeConfig({ ...config, agents: agentList });
	});

const readAgentInstructionsFn = createServerFn({ method: "GET" })
	.validator((raw) => agentPathSchema.parse(raw))
	.handler(async ({ data: agentPath }) => {
		const config = await getConfig();
		const allowedPaths = (config.agents ?? []).map((a) =>
			resolve(expandTilde(a.path)),
		);
		const requested = resolve(expandTilde(agentPath));
		if (!allowedPaths.some((p) => samePath(p, requested)))
			throw new Error("Unauthorized");
		return readAgentInstructions(requested);
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
	const navigate = useNavigate();

	const { agents, handleRemove, handleModeChange, handleSaveEdit, handleAdd } =
		useAgentRoster({
			initialAgents,
			saveAgentsFn,
			validateAgentPathFn,
			getAgentsFn,
		});
	const [showAdd, setShowAdd] = useState(false);

	async function handleAddSubmit(
		path: string,
		name: string,
		mode: "cwd" | "context",
		provider: string,
		settings: AgentProviderSettings,
	) {
		await handleAdd(path, name, mode, provider, settings);
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
			<div
				data-scroll-restoration-id={
					ROUTE_SCROLL_RESTORATION_IDS.einherjarContent
				}
				data-scroll-to-top="route"
				className="flex-1 overflow-auto p-5 space-y-6"
			>
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
						onAdd={handleAddSubmit}
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
								onReadInstructions={() =>
									readAgentInstructionsFn({ data: agent.path })
								}
								providers={providers}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}
