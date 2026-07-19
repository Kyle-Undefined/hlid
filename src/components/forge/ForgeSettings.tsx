import { useEffect, useMemo, useState } from "react";
import { AcpSection } from "#/components/forge/AcpSection";
import { ApiSection } from "#/components/forge/ApiSection";
import { AutoSleepSection } from "#/components/forge/AutoSleepSection";
import {
	ClaudeSection,
	ComputerUseSection,
} from "#/components/forge/ClaudeSection";
import { CustomThemeSection } from "#/components/forge/CustomThemeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { InstructionFilesSection } from "#/components/forge/InstructionFilesSection";
import { McpSection } from "#/components/forge/McpSection";
import { NetworkSection } from "#/components/forge/NetworkSection";
import { PricingSection } from "#/components/forge/PricingSection";
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
import { includesSearchText } from "#/lib/search";
import { applyThemeToDocument, effectiveTheme } from "#/lib/theme";

const CATEGORIES = [
	{
		id: "overview",
		label: "Overview",
		description: "Updates, installation, startup, and storage",
		sections: ["Updates", "Installation and startup", "Storage summary"],
		keywords: "version install location launch login database attachments",
		group: "primary",
	},
	{
		id: "workspace",
		label: "Workspace",
		description: "Vault identity, folders, and status vocabulary",
		sections: ["Vault", "Status Vocabulary"],
		keywords: "vault identity path folder mappings statuses",
		group: "primary",
	},
	{
		id: "agents",
		label: "Agents",
		description: "Provider, model, permissions, limits, and recaps",
		sections: [
			"Vault Agent",
			"Agent Instructions",
			"Computer Use",
			"Auto-sleep on usage limit",
		],
		keywords:
			"provider model effort permissions turns recaps account instructions agents md claude global wsl computer use windows desktop auto sleep usage limit rate window resume",
		group: "primary",
	},
	{
		id: "access",
		label: "Access",
		description: "Network, TLS, passwords, and trusted devices",
		sections: ["Network", "App Password", "Trusted Devices"],
		keywords:
			"port local network tailscale tls password trusted devices lock logout sign out",
		group: "primary",
	},
	{
		id: "experience",
		label: "Experience",
		description: "Themes, input, voice, and privacy",
		sections: [
			"UI",
			"Custom theme",
			"Custom palette",
			"Voice input",
			"Whisper models",
			"Privacy",
		],
		keywords: "theme mobile enter skills plans whisper microphone demo",
		group: "primary",
	},
	{
		id: "integrations",
		label: "Integrations",
		description: "MCP servers, external agents, and ACP",
		sections: [
			"MCP",
			"Umbod policy",
			"Generate agent hooks",
			"Umbod activity",
			"Call explorer",
			"ACP Agent Catalog",
		],
		keywords: "mcp servers external agents acp catalog integrations",
		group: "secondary",
	},
	{
		id: "developer",
		label: "Developer",
		description: "Event log, API reference, and pricing catalog",
		sections: ["Event Log", "API Reference", "Pricing"],
		keywords:
			"events logs api diagnostics endpoints pricing costs rates model aliases overrides",
		group: "secondary",
	},
	{
		id: "advanced",
		label: "Advanced",
		description: "Maintenance and session lifecycle",
		sections: ["Danger zone", "Session lifecycle"],
		keywords: "optimize database reload session shutdown danger",
		group: "secondary",
	},
] as const;
type Category = (typeof CATEGORIES)[number]["id"];
type DeveloperView = "events" | "api" | "pricing";
type ThemeTarget = "desktop" | "mobile";

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
		<>
			<ClaudeSection
				claude={agentForm}
				onChange={state.changeClaude}
				providers={initial.providers}
				accountInfo={initial.accountInfo}
			/>
			<InstructionFilesSection />
			<ComputerUseSection
				claude={agentForm}
				onChange={state.changeClaude}
				providers={initial.providers}
			/>
		</>
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

function CustomThemePage({
	state,
	onBack,
	target,
	onTargetChange,
}: {
	state: SettingsFormState;
	onBack: () => void;
	target: ThemeTarget;
	onTargetChange: (target: ThemeTarget) => void;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onBack}
				className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
			>
				← Experience
			</button>
			<PageIntro
				title="Custom Theme"
				description="Shape separate desktop and mobile palettes with a live system-wide preview. Changes save automatically."
			/>
			<CustomThemeSection
				ui={state.ui}
				onChange={(patch) => state.setUi((ui) => ({ ...ui, ...patch }))}
				target={target}
				onTargetChange={onTargetChange}
			/>
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
	onShowTheme,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	onShowTheme: () => void;
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
			<div className="border border-border bg-card p-4 flex items-center justify-between gap-4">
				<div>
					<div className="text-sm">Custom theme</div>
					<p className="text-xs text-muted-foreground mt-0.5">
						Edit desktop and mobile palettes on their own live-preview screen.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowTheme}
					className="shrink-0 px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Open theme editor
				</button>
			</div>
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
				description="Inspect runtime activity, the local API surface, and cost-estimation inputs."
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
						["pricing", "Pricing"],
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
			{developerView === "events" ? (
				<EventLogSection />
			) : developerView === "api" ? (
				<ApiSection />
			) : (
				<PricingSection />
			)}
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
	showTheme,
	onShowTheme,
	themeTarget,
	onThemeTarget,
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
	showTheme: boolean;
	onShowTheme: (show: boolean) => void;
	themeTarget: ThemeTarget;
	onThemeTarget: (target: ThemeTarget) => void;
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
	if (category === "experience" && showTheme)
		return (
			<CustomThemePage
				state={state}
				onBack={() => onShowTheme(false)}
				target={themeTarget}
				onTargetChange={onThemeTarget}
			/>
		);
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
			return (
				<ExperienceCategory
					state={state}
					initial={initial}
					onShowTheme={() => onShowTheme(true)}
				/>
			);
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
			{!state.saving && state.error && (
				<span className="inline-flex flex-wrap items-center gap-2 text-destructive">
					<span>{state.error}</span>
					<button
						type="button"
						onClick={() => void state.save()}
						className="border border-destructive/40 px-1.5 py-0.5 hover:bg-destructive/10"
					>
						Retry save
					</button>
				</span>
			)}
			{!state.saving && !state.error && state.dirty && (
				<span className="text-[var(--status-warning)]">Unsaved changes…</span>
			)}
			{!state.dirty && state.savedMsg === "saved" && (
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

function InventoryStatus({
	status,
	onRetry,
}: {
	status: "loading" | "ready" | "unavailable";
	onRetry: () => void;
}) {
	if (status === "ready") return null;
	if (status === "loading") {
		return (
			<span className="text-[10px] tracking-wider text-muted-foreground uppercase">
				Refreshing system inventory…
			</span>
		);
	}
	return (
		<button
			type="button"
			onClick={onRetry}
			className="border border-amber-500/40 px-2 py-1 text-[10px] tracking-wider text-[var(--status-warning)] hover:bg-amber-500/10 uppercase"
		>
			Inventory unavailable · Retry
		</button>
	);
}

export function ForgeSettings({
	initial,
	state,
	inventoryStatus = "ready",
	onRetryInventory = () => {},
}: {
	initial: SettingsInitial;
	state: SettingsFormState;
	inventoryStatus?: "loading" | "ready" | "unavailable";
	onRetryInventory?: () => void;
}) {
	const [category, setCategory] = useState<Category>("overview");
	const [search, setSearch] = useState("");
	const [showCatalog, setShowCatalog] = useState(false);
	const [showUmbod, setShowUmbod] = useState(false);
	const [showTheme, setShowTheme] = useState(false);
	const [themeTarget, setThemeTarget] = useState<ThemeTarget>("desktop");
	const [developerView, setDeveloperView] = useState<DeveloperView>("events");
	const shown = useMemo(() => {
		const q = search.trim();
		return q
			? CATEGORIES.filter((item) =>
					includesSearchText(
						`${item.label} ${item.description} ${item.sections.join(" ")} ${item.keywords}`,
						q,
					),
				)
			: CATEGORIES;
	}, [search]);
	useEffect(() => {
		if (!search.trim() || shown.length === 0) return;
		if (shown.some((item) => item.id === category)) return;
		setCategory(shown[0].id);
		setShowCatalog(false);
		setShowUmbod(false);
		setShowTheme(false);
	}, [category, search, shown]);
	function choose(next: Category) {
		setCategory(next);
		setShowCatalog(false);
		setShowUmbod(false);
		setShowTheme(false);
	}
	useEffect(() => {
		const media =
			typeof window.matchMedia === "function"
				? window.matchMedia("(pointer: coarse)")
				: null;
		const apply = () => {
			if (showTheme) {
				applyThemeToDocument(
					"custom",
					themeTarget === "desktop"
						? state.ui.customTheme
						: state.ui.mobileCustomTheme,
				);
				return;
			}
			const selected = effectiveTheme(state.ui, media?.matches ?? false);
			applyThemeToDocument(selected.name, selected.palette);
			try {
				localStorage.setItem("hlid-theme", selected.name);
				if (selected.palette)
					localStorage.setItem(
						"hlid-theme-palette",
						JSON.stringify(selected.palette),
					);
				else localStorage.removeItem("hlid-theme-palette");
			} catch {}
		};
		apply();
		media?.addEventListener("change", apply);
		return () => media?.removeEventListener("change", apply);
	}, [showTheme, state.ui, themeTarget]);
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
						value={shown.some((item) => item.id === category) ? category : ""}
						onChange={(e) => choose(e.target.value as Category)}
						aria-label="Filtered Forge category"
						className="md:hidden w-full min-w-0 bg-secondary border border-border px-2 py-1.5 text-xs"
					>
						{shown.length === 0 && <option value="">No matches</option>}
						{shown.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
					<input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter setting categories"
						aria-label="Filter setting categories"
						className="col-span-2 row-start-2 w-full bg-secondary border border-border px-3 py-1.5 text-xs focus:outline-none focus:border-primary/50 md:col-span-1 md:row-auto md:ml-auto md:max-w-sm"
					/>
					<InventoryStatus
						status={inventoryStatus}
						onRetry={onRetryInventory}
					/>
					<SaveStatus state={state} onRestartRequired={showRestartControls} />
				</PageHeader>
				<div
					data-scroll-restoration-id={
						ROUTE_SCROLL_RESTORATION_IDS.forgeSettings
					}
					data-scroll-to-top="route"
					className="flex-1 overflow-auto"
				>
					<div className="max-w-[1000px] mx-auto p-4 sm:p-6 space-y-6">
						{shown.length === 0 ? (
							<div className="border border-border bg-card p-6 text-center space-y-3">
								<p className="text-sm text-muted-foreground">
									No setting category matches “{search.trim()}”.
								</p>
								<button
									type="button"
									onClick={() => setSearch("")}
									className="border border-border px-3 py-1.5 text-[10px] tracking-widest uppercase hover:bg-accent"
								>
									Clear filter
								</button>
							</div>
						) : (
							<CategoryContent
								category={category}
								state={state}
								initial={initial}
								showCatalog={showCatalog}
								onShowCatalog={setShowCatalog}
								showUmbod={showUmbod}
								onShowUmbod={setShowUmbod}
								showTheme={showTheme}
								onShowTheme={setShowTheme}
								themeTarget={themeTarget}
								onThemeTarget={setThemeTarget}
								developerView={developerView}
								onDeveloperView={setDeveloperView}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
