import { useEffect, useMemo, useState } from "react";
import { AcpSection } from "#/components/forge/AcpSection";
import { ApiSection } from "#/components/forge/ApiSection";
import { AutoSleepSection } from "#/components/forge/AutoSleepSection";
import { ClaudeSection } from "#/components/forge/ClaudeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { McpSection } from "#/components/forge/McpSection";
import { NetworkSection } from "#/components/forge/NetworkSection";
import { SecuritySection } from "#/components/forge/SecuritySection";
import { SessionSection } from "#/components/forge/SessionSection";
import { SystemSection } from "#/components/forge/SystemSection";
import { UiSection } from "#/components/forge/UiSection";
import { UmbodSection } from "#/components/forge/UmbodSection";
import { UpdatesSection } from "#/components/forge/UpdatesSection";
import { VaultSection } from "#/components/forge/VaultSection";
import { VocabSection } from "#/components/forge/VocabSection";
import { VoiceSection } from "#/components/forge/VoiceSection";
import { PageHeader, PageIntro } from "#/components/shell/PageHeader";
import { SectionRail } from "#/components/shell/SectionRail";
import type {
	SettingsFormState,
	SettingsInitial,
} from "#/hooks/useSettingsForm";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";

const CATEGORIES = [
	{
		id: "overview",
		label: "Overview",
		description: "Updates, installation, startup, and storage",
		keywords: "version install location launch login database attachments",
		group: "primary",
	},
	{
		id: "workspace",
		label: "Workspace",
		description: "Vault identity, folders, and status vocabulary",
		keywords: "vault identity path folder mappings statuses",
		group: "primary",
	},
	{
		id: "agents",
		label: "Agents",
		description: "Provider, model, permissions, limits, and recaps",
		keywords:
			"provider model effort permissions turns recaps account auto sleep usage limit rate window resume",
		group: "primary",
	},
	{
		id: "access",
		label: "Access",
		description: "Network, TLS, passwords, and trusted devices",
		keywords:
			"port local network tailscale tls password trusted devices lock logout sign out",
		group: "primary",
	},
	{
		id: "experience",
		label: "Experience",
		description: "Themes, input, voice, and privacy",
		keywords: "theme mobile enter skills plans whisper microphone demo",
		group: "primary",
	},
	{
		id: "integrations",
		label: "Integrations",
		description: "MCP servers, external agents, and ACP",
		keywords: "mcp servers external agents acp catalog integrations",
		group: "secondary",
	},
	{
		id: "developer",
		label: "Developer",
		description: "Event log and API reference",
		keywords: "events logs api diagnostics endpoints",
		group: "secondary",
	},
	{
		id: "advanced",
		label: "Advanced",
		description: "Maintenance and session lifecycle",
		keywords: "optimize database reload session shutdown danger",
		group: "secondary",
	},
] as const;
type Category = (typeof CATEGORIES)[number]["id"];
type DeveloperView = "events" | "api";

function AgentSettings({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	const agentForm =
		state.claude.vaultProvider === "codex"
			? {
					...state.codex,
					vaultProvider: state.claude.vaultProvider,
					interactiveMode: state.claude.interactiveMode,
				}
			: state.claude;
	return (
		<ClaudeSection
			claude={agentForm}
			onChange={state.changeClaude}
			providers={initial.providers}
			accountInfo={initial.accountInfo}
		/>
	);
}

function AcpCatalogPage({
	state,
	initial,
	onBack,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	onBack: () => void;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onBack}
				className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
			>
				← Integrations
			</button>
			<PageIntro
				title="ACP Agent Catalog"
				description="Discover and configure Agent Client Protocol integrations."
			/>
			<AcpSection
				initialCatalog={initial.acpCatalog}
				value={state.acpAgents}
				onChange={state.setAcpAgents}
			/>
		</>
	);
}

function UmbodPage({
	state,
	onBack,
}: {
	state: SettingsFormState;
	onBack: () => void;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onBack}
				className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
			>
				← Integrations
			</button>
			<PageIntro
				title="Umbod"
				description="Configure policy, generate hooks, and inspect tool-call decisions."
			/>
			<UmbodSection value={state.umbod} onChange={state.setUmbod} />
		</>
	);
}

function OverviewCategory() {
	return (
		<>
			<PageIntro
				title="Overview"
				description="Keep Hlið current and understand how this installation is running."
			/>
			<UpdatesSection />
			<SystemSection view="overview" />
		</>
	);
}

function WorkspaceCategory({ state }: { state: SettingsFormState }) {
	return (
		<>
			<PageIntro
				title="Workspace"
				description="Define the vault Hlið works in and the vocabulary it uses."
			/>
			<VaultSection
				vault={state.vault}
				onChange={(patch) => state.setVault((v) => ({ ...v, ...patch }))}
			/>
			<VocabSection
				vocab={state.vocab}
				onChange={(patch) => state.setVocab((v) => ({ ...v, ...patch }))}
			/>
		</>
	);
}

function AgentsCategory({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	return (
		<>
			<PageIntro
				title="Agents"
				description="Choose the default provider and control how agents work."
			/>
			<AgentSettings state={state} initial={initial} />
			<AutoSleepSection
				value={state.autoSleep}
				onChange={(patch) =>
					state.setAutoSleep((form) => ({ ...form, ...patch }))
				}
			/>
		</>
	);
}

function AccessCategory({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	return (
		<>
			<PageIntro
				title="Access"
				description="Control where Hlið is reachable and who can sign in."
			/>
			<NetworkSection
				server={state.server}
				onChange={(patch) => state.setServer((s) => ({ ...s, ...patch }))}
				cwd={initial.cwd}
			/>
			<SecuritySection />
		</>
	);
}

function ExperienceCategory({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	return (
		<>
			<PageIntro
				title="Experience"
				description="Tune appearance, input behavior, voice, and presentation privacy."
			/>
			<UiSection
				ui={state.ui}
				onChange={(patch) => state.setUi((ui) => ({ ...ui, ...patch }))}
			/>
			<VoiceSection
				voice={state.voice}
				onChange={(patch) =>
					state.setVoice((voice) => ({ ...voice, ...patch }))
				}
				initialInfo={initial.voiceInfo}
			/>
			<SessionSection view="privacy" />
		</>
	);
}

function IntegrationsCategory({
	state,
	onShowUmbod,
	onShowCatalog,
}: {
	state: SettingsFormState;
	onShowUmbod: () => void;
	onShowCatalog: () => void;
}) {
	return (
		<>
			<PageIntro
				title="Integrations"
				description="Connect tools and agents without crowding core agent settings."
			/>
			<McpSection vaultPath={state.vault.path} />
			<div className="border border-border bg-card p-4 flex items-center justify-between gap-4">
				<div>
					<div className="text-sm">Umbod policy</div>
					<p className="text-xs text-muted-foreground mt-0.5">
						Configure enforcement, generate hooks, and inspect tool calls.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowUmbod}
					className="shrink-0 px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Open Umbod
				</button>
			</div>
			<div className="border border-border bg-card p-4 flex items-center justify-between gap-4">
				<div>
					<div className="text-sm">ACP Agent Catalog</div>
					<p className="text-xs text-muted-foreground mt-0.5">
						Browse and configure Agent Client Protocol integrations on their own
						screen.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowCatalog}
					className="shrink-0 px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Open catalog
				</button>
			</div>
		</>
	);
}

function DeveloperCategory({
	developerView,
	onDeveloperView,
}: {
	developerView: DeveloperView;
	onDeveloperView: (view: DeveloperView) => void;
}) {
	return (
		<>
			<PageIntro
				title="Developer"
				description="Inspect runtime activity and the local API surface."
			/>
			<div
				className="inline-flex border border-border bg-card p-1"
				role="tablist"
				aria-label="Developer tools"
			>
				{(
					[
						["events", "Event Log"],
						["api", "API Reference"],
					] as const
				).map(([view, label]) => (
					<button
						key={view}
						type="button"
						role="tab"
						onClick={() => onDeveloperView(view)}
						aria-selected={developerView === view}
						className={`px-3 py-1.5 text-[10px] tracking-widest uppercase transition-colors ${
							developerView === view
								? "bg-primary/10 text-primary"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						}`}
					>
						{label}
					</button>
				))}
			</div>
			{developerView === "events" ? <EventLogSection /> : <ApiSection />}
		</>
	);
}

function AdvancedCategory() {
	return (
		<>
			<PageIntro
				title="Advanced"
				description="Maintenance and lifecycle actions. Review destructive actions carefully."
			/>
			<SystemSection view="advanced" />
			<SessionSection view="advanced" />
		</>
	);
}

function CategoryContent({
	category,
	state,
	initial,
	showCatalog,
	onShowCatalog,
	showUmbod,
	onShowUmbod,
	developerView,
	onDeveloperView,
}: {
	category: Category;
	state: SettingsFormState;
	initial: SettingsInitial;
	showCatalog: boolean;
	onShowCatalog: (show: boolean) => void;
	showUmbod: boolean;
	onShowUmbod: (show: boolean) => void;
	developerView: DeveloperView;
	onDeveloperView: (view: DeveloperView) => void;
}) {
	if (category === "integrations" && showCatalog)
		return (
			<AcpCatalogPage
				state={state}
				initial={initial}
				onBack={() => onShowCatalog(false)}
			/>
		);
	if (category === "integrations" && showUmbod)
		return <UmbodPage state={state} onBack={() => onShowUmbod(false)} />;
	switch (category) {
		case "overview":
			return <OverviewCategory />;
		case "workspace":
			return <WorkspaceCategory state={state} />;
		case "agents":
			return <AgentsCategory state={state} initial={initial} />;
		case "access":
			return <AccessCategory state={state} initial={initial} />;
		case "experience":
			return <ExperienceCategory state={state} initial={initial} />;
		case "integrations":
			return (
				<IntegrationsCategory
					state={state}
					onShowUmbod={() => onShowUmbod(true)}
					onShowCatalog={() => onShowCatalog(true)}
				/>
			);
		case "developer":
			return (
				<DeveloperCategory
					developerView={developerView}
					onDeveloperView={onDeveloperView}
				/>
			);
		case "advanced":
			return <AdvancedCategory />;
	}
}

function SaveStatus({
	state,
	onRestartRequired,
}: {
	state: SettingsFormState;
	onRestartRequired: () => void;
}) {
	return (
		<div
			className="min-h-5 text-[10px] tracking-wider uppercase"
			aria-live="polite"
		>
			{state.saving && <span className="text-muted-foreground">Saving…</span>}
			{state.error && <span className="text-destructive">{state.error}</span>}
			{state.savedMsg === "saved" && (
				<span className="text-green-500">Saved</span>
			)}
			{state.savedMsg === "restart" && (
				<span className="inline-flex items-center gap-2 text-amber-500">
					<button
						type="button"
						onClick={onRestartRequired}
						className="border border-amber-500/40 px-1.5 py-0.5 hover:bg-amber-500/10"
					>
						Restart required
					</button>{" "}
					Changes saved
				</span>
			)}
		</div>
	);
}

export function ForgeSettings({
	initial,
	state,
}: {
	initial: SettingsInitial;
	state: SettingsFormState;
}) {
	const [category, setCategory] = useState<Category>("overview");
	const [search, setSearch] = useState("");
	const [showCatalog, setShowCatalog] = useState(false);
	const [showUmbod, setShowUmbod] = useState(false);
	const [developerView, setDeveloperView] = useState<DeveloperView>("events");
	const shown = useMemo(() => {
		const q = search.trim().toLowerCase();
		return q
			? CATEGORIES.filter((item) =>
					`${item.label} ${item.description} ${item.keywords}`
						.toLowerCase()
						.includes(q),
				)
			: CATEGORIES;
	}, [search]);
	useEffect(() => {
		if (!search.trim() || shown.length === 0) return;
		if (shown.some((item) => item.id === category)) return;
		setCategory(shown[0].id);
		setShowCatalog(false);
		setShowUmbod(false);
	}, [category, search, shown]);
	function choose(next: Category) {
		setCategory(next);
		setShowCatalog(false);
		setShowUmbod(false);
	}
	function showRestartControls() {
		choose("advanced");
		setTimeout(() => {
			document
				.getElementById("lifecycle-controls")
				?.scrollIntoView({ behavior: "smooth", block: "start" });
		}, 0);
	}
	return (
		<div className="flex h-full min-h-0">
			<SectionRail
				items={shown.map((item) => ({
					id: item.id,
					label: item.label,
					group: item.group,
				}))}
				activeId={category}
				onSelect={(id) => choose(id as Category)}
				label="Forge categories"
			/>
			<div className="flex-1 min-w-0 flex flex-col">
				<PageHeader eyebrow="Forge">
					<select
						value={category}
						onChange={(e) => choose(e.target.value as Category)}
						aria-label="Forge category"
						className="md:hidden w-full min-w-0 bg-secondary border border-border px-2 py-1.5 text-xs"
					>
						{CATEGORIES.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search settings"
						aria-label="Search settings"
						className="col-span-2 row-start-2 w-full bg-secondary border border-border px-3 py-1.5 text-xs focus:outline-none focus:border-primary/50 md:col-span-1 md:row-auto md:ml-auto md:max-w-sm"
					/>
					<SaveStatus state={state} onRestartRequired={showRestartControls} />
				</PageHeader>
				<main
					data-scroll-restoration-id={
						ROUTE_SCROLL_RESTORATION_IDS.forgeSettings
					}
					data-scroll-to-top="route"
					className="flex-1 overflow-auto"
				>
					<div className="max-w-[1000px] mx-auto p-4 sm:p-6 space-y-6">
						<CategoryContent
							category={category}
							state={state}
							initial={initial}
							showCatalog={showCatalog}
							onShowCatalog={setShowCatalog}
							showUmbod={showUmbod}
							onShowUmbod={setShowUmbod}
							developerView={developerView}
							onDeveloperView={setDeveloperView}
						/>
					</div>
				</main>
			</div>
		</div>
	);
}
