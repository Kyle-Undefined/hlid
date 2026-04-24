import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { FirstRunWizard } from "#/components/wizard/FirstRunWizard";
import { getConfig } from "#/config";
import { useWs } from "#/hooks/useWs";
import { scanProjects } from "#/lib/vault";
import type { ServerMessage } from "#/server/protocol";

const getCockpitStats = createServerFn({ method: "GET" }).handler(async () => {
	const config = await getConfig();

	let inboxCount = 0;
	if (config.vault.path && config.vault.inbox) {
		try {
			inboxCount = readdirSync(
				join(config.vault.path, config.vault.inbox),
			).filter((f) => f.endsWith(".md")).length;
		} catch {
			inboxCount = 0;
		}
	}

	let activeCount = 0;
	let totalCount = 0;
	if (config.vault.path && config.vault.projects) {
		const projects = scanProjects(
			config.vault.path,
			config.vault.projects,
			config.status_vocabulary,
		);
		totalCount = projects.length;
		activeCount = projects.filter((p) => p.status === "active").length;
	}

	return { inboxCount, activeCount, totalCount };
});

export const Route = createFileRoute("/")({
	loader: async () => {
		const [config, stats] = await Promise.all([getConfig(), getCockpitStats()]);
		return { config, stats };
	},
	component: CockpitPage,
});

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="p-4 rounded-lg border border-border bg-card">
			<div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
				{label}
			</div>
			<div className="text-2xl font-semibold text-foreground tabular-nums">
				{value}
			</div>
		</div>
	);
}

function VaultCard({
	vault,
}: {
	vault: { name: string; path: string; inbox?: string; projects?: string };
}) {
	return (
		<div className="p-4 rounded-lg border border-border bg-card">
			<div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
				Vault
			</div>
			<div className="font-medium text-foreground">{vault.name}</div>
			<div className="text-xs text-muted-foreground mt-1 font-mono truncate">
				{vault.path}
			</div>
		</div>
	);
}

function SessionBadge() {
	const { wsStatus, sessionState, model } = useWs();

	if (wsStatus === "disconnected" || wsStatus === "connecting") {
		return (
			<div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-muted-foreground text-xs font-medium">
				<div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
				Offline
			</div>
		);
	}

	if (sessionState === "running") {
		return (
			<div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-xs font-medium text-foreground">
				<div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
				Running
			</div>
		);
	}

	if (sessionState === "error") {
		return (
			<div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-xs font-medium text-destructive">
				<div className="w-1.5 h-1.5 rounded-full bg-destructive" />
				Error
			</div>
		);
	}

	return (
		<div
			className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-xs font-medium text-foreground"
			title={model}
		>
			<div className="w-1.5 h-1.5 rounded-full bg-green-400" />
			Ready
		</div>
	);
}

function CockpitPage() {
	const { config, stats } = Route.useLoaderData();
	const router = useRouter();
	const [sessionCost, setSessionCost] = useState<number>(0);

	const { wsStatus } = useWs((msg: ServerMessage) => {
		if (msg.type === "done" && msg.cost != null) {
			const cost = msg.cost;
			setSessionCost((prev) => prev + cost);
		}
	});

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

	const costStr =
		sessionCost > 0
			? `$${sessionCost.toFixed(4)}`
			: wsStatus === "connected"
				? "$0.0000"
				: "--";

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<div className="flex items-start justify-between mb-8">
				<div>
					<h1 className="text-xl font-semibold text-foreground tracking-tight">
						Cockpit
					</h1>
					<p className="text-sm text-muted-foreground mt-0.5">
						{config.vault.name || "Hlid"}
					</p>
				</div>
				<SessionBadge />
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
				<StatCard
					label="Inbox"
					value={config.vault.inbox ? String(stats.inboxCount) : "--"}
				/>
				<StatCard
					label="Active Projects"
					value={config.vault.projects ? String(stats.activeCount) : "--"}
				/>
				<StatCard label="Session Cost" value={costStr} />
			</div>

			<VaultCard vault={config.vault} />

			<div className="mt-4 p-4 rounded-lg border border-border bg-card">
				<div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
					Recent Activity
				</div>
				<p className="text-sm text-muted-foreground">
					{wsStatus === "connected"
						? "Session ready. Start a conversation in Chat."
						: "Server offline."}
				</p>
			</div>
		</div>
	);
}
