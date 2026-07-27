import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	type HlidApiEndpoint,
	type HlidApiIndex,
	parseHlidApiIndex,
} from "../../lib/apiIndex";
import { dbFetch } from "../../lib/dbClient";

type ApiGroupId =
	| "system"
	| "session"
	| "config"
	| "mcp"
	| "agents"
	| "vault"
	| "packages";

type ApiGroup = {
	id: ApiGroupId;
	label: string;
	description: string;
	skillPurpose: string;
};

const API_GROUPS: ApiGroup[] = [
	{
		id: "system",
		label: "System API",
		description:
			"Discovery, provider state, authentication, maintenance, lifecycle, logs, and health",
		skillPurpose:
			"discover the API, inspect health and provider state, review logs, and perform explicitly requested maintenance",
	},
	{
		id: "session",
		label: "Session API",
		description:
			"Session history, messages, context, usage, attachments, Relics, and live session controls",
		skillPurpose:
			"inspect session history and usage, manage live sessions, and handle session-owned artifacts",
	},
	{
		id: "config",
		label: "Config & Pricing API",
		description: "Read and write configuration and pricing overrides",
		skillPurpose:
			"inspect Hlid configuration and pricing, and make narrowly requested updates",
	},
	{
		id: "mcp",
		label: "MCP API",
		description: "Review and manage vault and agent MCP servers",
		skillPurpose:
			"inspect provider-scoped MCP state and manage explicitly selected MCP servers",
	},
	{
		id: "agents",
		label: "Agent API",
		description: "List, save, validate agents and read context instructions",
		skillPurpose:
			"inspect registered agents, validate agent paths, and read their exact instruction files",
	},
	{
		id: "vault",
		label: "Vault API",
		description: "Read Hlid's curated vault data surfaces",
		skillPurpose:
			"read the exact vault data exposed by Hlid without bypassing vault boundaries",
	},
	{
		id: "packages",
		label: "Extensions & Skills API",
		description:
			"Discover, review, install, import, and remove provider extensions and skills",
		skillPurpose:
			"review extension and skill packages before performing explicitly requested provider-native mutations",
	},
];

function apiGroupId(endpoint: HlidApiEndpoint): ApiGroupId {
	const path = endpoint.path;
	if (path.includes("mcp")) return "mcp";
	if (path.startsWith("/api/agents")) return "agents";
	if (path.startsWith("/api/vault")) return "vault";
	if (path === "/api/config" || path === "/api/pricing") return "config";
	if (path.startsWith("/skills") || path.startsWith("/extensions")) {
		return "packages";
	}
	if (
		(path.startsWith("/db/") &&
			!path.startsWith("/db/logs") &&
			!path.startsWith("/db/provider-usage")) ||
		path.startsWith("/api/attachments") ||
		path.startsWith("/api/relics") ||
		path.startsWith("/api/project-previews")
	) {
		return "session";
	}
	return "system";
}

function endpointBaseUrl(index: HlidApiIndex, endpoint: HlidApiEndpoint) {
	return endpoint.server === "api"
		? `http://127.0.0.1:${index.api_port}`
		: `http://127.0.0.1:${index.ui_port}`;
}

function buildSkillPrompt(
	group: ApiGroup,
	endpoints: HlidApiEndpoint[],
	index: HlidApiIndex,
): string {
	const catalog = endpoints
		.map(
			(endpoint) =>
				`- \`${endpoint.method} ${endpoint.path}\` on ${endpoint.server} (${endpointBaseUrl(index, endpoint)}): ${endpoint.desc}`,
		)
		.join("\n");
	return `Create a vault skill for Hlid's ${group.label}.

The skill should ${group.skillPurpose}.

Use Hlid's live \`GET /api-index\` response as the source of truth. The current catalog reports:
- Data API: \`http://127.0.0.1:${index.api_port}\`
- UI API: \`http://127.0.0.1:${index.ui_port}\`

## Current endpoints

${catalog}

Treat GET endpoints as read-only only when their endpoint contract says so. POST, PATCH, and DELETE endpoints may mutate state. Include endpoint-specific request requirements, check responses before reporting success, and ask for approval when the active policy requires it. Do not bypass Hlid permissions or provider-native controls.

Create a skill file in the vault's configured skills folder with YAML frontmatter containing \`name\` and \`description\`. Include concise request and response examples for an agent. Register it in the vault skill index using the existing section and table format.`;
}

export function ApiSection() {
	const navigate = useNavigate();
	const [index, setIndex] = useState<HlidApiIndex | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await dbFetch("/api-index");
				if (!response.ok) {
					throw new Error(`API catalog request failed (${response.status}).`);
				}
				const next = parseHlidApiIndex(await response.json());
				if (!cancelled) setIndex(next);
			} catch (cause) {
				if (!cancelled) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load the API catalog.",
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	function buildSkill(group: ApiGroup, endpoints: HlidApiEndpoint[]) {
		if (!index) return;
		void navigate({
			to: "/raven",
			search: { prompt: buildSkillPrompt(group, endpoints, index) },
		});
	}

	return (
		<div className="space-y-4">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				API Reference
			</div>
			<p className="text-xs text-muted-foreground">
				Live REST endpoints from Hlid&apos;s curated API catalog. Each group can
				pre-fill a Raven prompt for a focused SKILL.md.
			</p>

			{index ? (
				<div className="text-[10px] text-muted-foreground">
					Data <span className="font-mono">127.0.0.1:{index.api_port}</span>
					{" · "}UI <span className="font-mono">127.0.0.1:{index.ui_port}</span>
				</div>
			) : null}

			{error ? (
				<div className="border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive">
					{error}
				</div>
			) : null}

			{!index && !error ? (
				<div className="border border-border bg-card p-4 text-xs text-muted-foreground">
					Loading the live API catalog…
				</div>
			) : null}

			{index ? (
				<div className="space-y-3">
					{API_GROUPS.map((group) => {
						const endpoints = index.endpoints.filter(
							(endpoint) => apiGroupId(endpoint) === group.id,
						);
						if (endpoints.length === 0) return null;
						return (
							<div
								key={group.id}
								className="border border-border bg-card p-4 space-y-3"
							>
								<div className="flex items-start justify-between gap-4">
									<div>
										<div className="text-[10px] tracking-widest font-semibold uppercase text-foreground">
											{group.label}
										</div>
										<div className="text-[10px] text-muted-foreground mt-0.5">
											{group.description}
										</div>
									</div>
									<button
										type="button"
										onClick={() => buildSkill(group, endpoints)}
										className="shrink-0 text-[8px] tracking-widest text-primary hover:opacity-70 uppercase transition-opacity"
									>
										Build Skill →
									</button>
								</div>

								<div className="space-y-2">
									{endpoints.map((endpoint) => (
										<div
											key={`${endpoint.method} ${endpoint.path}`}
											className="space-y-0.5"
										>
											<div className="font-mono text-[10px] text-muted-foreground/80">
												{endpoint.method.padEnd(6)} {endpoint.path}
												<span className="ml-2 text-muted-foreground/50">
													{endpoint.server}
												</span>
											</div>
											<div className="text-[10px] text-muted-foreground/65">
												{endpoint.desc}
											</div>
										</div>
									))}
								</div>
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
