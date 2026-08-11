import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AcpSection } from "#/components/forge/AcpSection";
import { ApiSection } from "#/components/forge/ApiSection";
import { AutoSleepSection } from "#/components/forge/AutoSleepSection";
import { BrowserProfileSection } from "#/components/forge/BrowserProfileSection";
import {
	ClaudeSection,
	ComputerUseSection,
} from "#/components/forge/ClaudeSection";
import { CliProxySection } from "#/components/forge/CliProxySection";
import { CustomThemeSection } from "#/components/forge/CustomThemeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { ExtensionsSection } from "#/components/forge/ExtensionsSection";
import { InstructionFilesSection } from "#/components/forge/InstructionFilesSection";
import { McpSection } from "#/components/forge/McpSection";
import { NetworkSection } from "#/components/forge/NetworkSection";
import { ObsidianSection } from "#/components/forge/ObsidianSection";
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
import { ProviderAppsCatalog } from "#/components/ProviderAppsCatalog";
import { PageHeader, PageIntro } from "#/components/shell/PageHeader";
import { SectionRail } from "#/components/shell/SectionRail";
import type {
	SettingsFormState,
	SettingsInitial,
} from "#/hooks/useSettingsForm";
import {
	FORGE_CATEGORIES,
	type ForgeCategoryId,
	type ForgeNavigationState,
	type ForgeSearchDestination,
	type ForgeThemeTarget,
	type ForgeView,
	getForgeCategory,
	getForgeNavigationFocusId,
	getForgeNavigationSettingLabel,
	normalizeForgeNavigation,
	searchForgeDestinations,
} from "#/lib/forgeNavigation";
import { CLIPROXY_CODEX_PROVIDER_ID } from "#/lib/providerIds";
import type { ProviderInfo } from "#/lib/providerTypes";
import { ROUTE_SCROLL_RESTORATION_IDS } from "#/lib/scrollContainers";
import { normalizeSearchText } from "#/lib/search";
import { applyThemeToDocument, effectiveTheme } from "#/lib/theme";

type Category = ForgeCategoryId;
type DeveloperView = Extract<ForgeView, "events" | "api" | "pricing">;
type ThemeTarget = ForgeThemeTarget;

const SEARCH_RESULT_LIMIT = 12;
const DEVELOPER_TABS = [
	["events", "Event Log"],
	["api", "API Reference"],
	["pricing", "Pricing"],
] as const satisfies ReadonlyArray<readonly [DeveloperView, string]>;

const CLAUDE_ONLY_SEARCH_SETTINGS = new Set([
	"subagent-progress-summaries",
	"interactive-mode",
	"claude-peer-inbox",
]);

function isSearchDestinationAvailable(
	destination: ForgeSearchDestination,
	vaultProvider: string,
	voiceInputProvider: SettingsFormState["voice"]["input_provider"],
) {
	const setting = destination.navigation.setting;
	if (!setting) return true;
	if (CLAUDE_ONLY_SEARCH_SETTINGS.has(setting))
		return vaultProvider === "claude";
	if (setting === "whisper-threads") return voiceInputProvider === "local";
	return true;
}

function findRenderedSettingTarget(
	navigation: ForgeNavigationState,
	fallbackId: string | undefined,
): HTMLElement | null {
	if (navigation.setting) {
		const explicit = document.getElementById(
			`forge-setting-${navigation.setting}`,
		);
		if (explicit) return explicit;

		const label = getForgeNavigationSettingLabel(navigation);
		const normalizedLabel = label ? normalizeSearchText(label) : "";
		if (normalizedLabel) {
			const candidates = Array.from(
				document.querySelectorAll<HTMLElement>("[data-forge-setting-label]"),
			);
			const exact = candidates.find(
				(candidate) => candidate.dataset.forgeSettingLabel === normalizedLabel,
			);
			if (exact) return exact;

			const sectionRoot = navigation.section
				? document.querySelector<HTMLElement>(
						`[data-forge-section="forge-section-${navigation.section}"]`,
					)
				: null;
			const scopedCandidates = sectionRoot
				? candidates.filter((candidate) => sectionRoot.contains(candidate))
				: candidates;
			const suffixMatches = scopedCandidates
				.filter((candidate) => {
					const candidateLabel = candidate.dataset.forgeSettingLabel ?? "";
					return (
						candidateLabel.length >= 4 &&
						(normalizedLabel.endsWith(` ${candidateLabel}`) ||
							normalizedLabel.startsWith(`${candidateLabel} `))
					);
				})
				.sort(
					(left, right) =>
						(right.dataset.forgeSettingLabel?.length ?? 0) -
						(left.dataset.forgeSettingLabel?.length ?? 0),
				);
			if (suffixMatches.length > 0) return suffixMatches[0];
		}
	}
	return fallbackId ? document.getElementById(fallbackId) : null;
}

function CategoryIntro({
	category,
	navigation,
	onNavigate,
	showSections = true,
}: {
	category: Category;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
	showSections?: boolean;
}) {
	const definition = getForgeCategory(category);
	return (
		<>
			<PageIntro
				id={`forge-category-${category}`}
				headingLevel={1}
				title={definition.label}
				description={definition.description}
			/>
			{showSections && definition.sections.length > 1 && (
				<nav aria-label={`${definition.label} settings`}>
					<div className="flex flex-wrap gap-2">
						{definition.sections.map((section) => {
							const active =
								navigation.section === section.id ||
								(section.view !== undefined &&
									navigation.view === section.view);
							return (
								<button
									key={section.id}
									type="button"
									onClick={() =>
										onNavigate({
											category,
											section: section.id,
											...(section.view ? { view: section.view } : {}),
										})
									}
									aria-current={active ? "location" : undefined}
									className={`min-h-11 border px-3 py-2 text-left text-[10px] tracking-wider uppercase transition-colors lg:min-h-0 lg:py-1.5 ${
										active
											? "border-primary/40 bg-primary/10 text-primary"
											: "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
									}`}
								>
									{section.label}
								</button>
							);
						})}
					</div>
				</nav>
			)}
		</>
	);
}

function NestedBackButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="min-h-11 px-1 text-[10px] tracking-widest text-muted-foreground uppercase hover:text-foreground lg:min-h-0"
		>
			← {label}
		</button>
	);
}

function SettingsSearchResults({
	query,
	results,
	truncated,
	onChoose,
	onClear,
}: {
	query: string;
	results: ForgeSearchDestination[];
	truncated: boolean;
	onChoose: (destination: ForgeSearchDestination) => void;
	onClear: () => void;
}) {
	return (
		<section aria-labelledby="forge-search-results-title" className="space-y-4">
			<div className="space-y-1">
				<h1 id="forge-search-results-title" className="text-lg font-medium">
					Search settings
				</h1>
				<p className="text-xs text-muted-foreground" aria-live="polite">
					{truncated
						? `Showing first ${results.length} results for “${query}”. Results are truncated. Narrow your search to refine the list.`
						: results.length > 0
							? `Showing ${results.length} ${results.length === 1 ? "result" : "results"} for “${query}”`
							: `No settings found for “${query}”`}
				</p>
			</div>
			{results.length > 0 ? (
				<div className="grid gap-2">
					{results.map((destination) => (
						<button
							key={destination.id}
							type="button"
							onClick={() => onChoose(destination)}
							className="group min-h-16 border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-accent focus-visible:border-primary/60 focus-visible:outline-none"
						>
							<span className="block text-sm text-foreground">
								{destination.label}
							</span>
							<span className="mt-0.5 block text-[10px] tracking-wider text-primary/80 uppercase">
								{destination.kind === "category"
									? "Category"
									: destination.breadcrumbs.slice(0, -1).join(" / ")}
							</span>
							<span className="mt-1 block text-xs text-muted-foreground">
								{destination.description}
							</span>
						</button>
					))}
				</div>
			) : (
				<div className="border border-border bg-card p-6 text-center">
					<button
						type="button"
						onClick={onClear}
						className="min-h-11 border border-border px-3 py-2 text-[10px] tracking-widest uppercase hover:bg-accent"
					>
						Clear search
					</button>
				</div>
			)}
		</section>
	);
}

function AgentSettings({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	const acpAgent = state.claude.vaultProvider.startsWith("acp:")
		? state.acpAgents.find(
				(agent) => agent.id === state.claude.vaultProvider.slice("acp:".length),
			)
		: undefined;
	const providerForm =
		state.claude.vaultProvider === "codex"
			? {
					...state.codex,
				}
			: state.claude.vaultProvider === CLIPROXY_CODEX_PROVIDER_ID
				? state.cliproxy
				: acpAgent
					? {
							model: acpAgent.model ?? "",
							effort: acpAgent.effort ?? "",
							maxTurns: "",
							permissionMode: acpAgent.permission_mode ?? "default",
							turnRecaps: acpAgent.turn_recaps ?? true,
							recapModel: acpAgent.recap_model ?? "",
						}
					: state.claude;
	const agentForm = {
		...providerForm,
		vaultProvider: state.claude.vaultProvider,
		agentProgressSummaries: state.claude.agentProgressSummaries,
		interactiveMode: state.claude.interactiveMode,
		peerInbox: state.claude.peerInbox,
	};
	return (
		<>
			<ClaudeSection
				claude={agentForm}
				onChange={state.changeClaude}
				providers={initial.providers}
				accountInfo={initial.accountInfo}
			/>
			<InstructionFilesSection
				vaultProvider={state.claude.vaultProvider}
				savedVaultProvider={initial.vault_provider}
			/>
			<BrowserProfileSection
				value={state.projectPreview}
				onChange={(patch) =>
					state.setProjectPreview((current) => ({ ...current, ...patch }))
				}
			/>
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
	onRefreshProviders,
	onDiscoverAcpModels,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	onBack: () => void;
	onRefreshProviders: (providerId: string) => void | Promise<void>;
	onDiscoverAcpModels?: (id: string) => Promise<ProviderInfo["models"]>;
}) {
	return (
		<>
			<NestedBackButton label="Integrations" onClick={onBack} />
			<PageIntro
				id="forge-view-acp"
				headingLevel={1}
				title="OpenCode and ACP integrations"
				description="Set up OpenCode through its supported ACP connection or discover another Agent Client Protocol integration."
			/>
			<AcpSection
				initialCatalog={initial.acpCatalog}
				value={state.acpAgents}
				savedValue={state.persistedAcpAgents}
				workspaceConfigurationCurrent={
					!state.acpRuntimePending &&
					state.vault.path === state.persistedVaultPath
				}
				providers={initial.providers}
				onChange={state.setAcpAgents}
				onRefreshProviders={onRefreshProviders}
				onDiscoverModels={
					onDiscoverAcpModels
						? (item) => onDiscoverAcpModels(item.id)
						: undefined
				}
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
			<NestedBackButton label="Integrations" onClick={onBack} />
			<PageIntro
				id="forge-view-umbod"
				headingLevel={1}
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
			<NestedBackButton label="Experience" onClick={onBack} />
			<PageIntro
				id="forge-view-theme"
				headingLevel={1}
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

function OverviewCategory({
	navigation,
	onNavigate,
}: {
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="overview"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<section
				aria-labelledby="forge-browse-settings-title"
				className="space-y-2"
			>
				<div className="px-1">
					<h2
						id="forge-browse-settings-title"
						className="text-[10px] tracking-widest text-muted-foreground uppercase"
					>
						Browse settings
					</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Jump into a category or search for a setting by name.
					</p>
				</div>
				<div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
					{FORGE_CATEGORIES.filter(
						(category) => category.id !== "overview",
					).map((category) => (
						<button
							key={category.id}
							type="button"
							onClick={() => onNavigate({ category: category.id })}
							className="min-h-20 border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent focus-visible:border-primary/60 focus-visible:outline-none"
						>
							<span className="block text-sm text-foreground">
								{category.label}
							</span>
							<span className="mt-1 block text-xs text-muted-foreground">
								{category.description}
							</span>
						</button>
					))}
				</div>
			</section>
			<UpdatesSection />
			<SystemSection view="overview" />
		</>
	);
}

function WorkspaceCategory({
	state,
	navigation,
	onNavigate,
}: {
	state: SettingsFormState;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="workspace"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<VaultSection
				vault={state.vault}
				onChange={(patch) => state.setVault((v) => ({ ...v, ...patch }))}
			/>
			<ObsidianSection
				rememberedCommands={state.vault.obsidianCommandAllowlist}
				onRememberedCommandsChange={(commands) =>
					state.setVault((vault) => ({
						...vault,
						obsidianCommandAllowlist: commands,
					}))
				}
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
	navigation,
	onNavigate,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="agents"
				navigation={navigation}
				onNavigate={onNavigate}
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
	navigation,
	onNavigate,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="access"
				navigation={navigation}
				onNavigate={onNavigate}
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
	navigation,
	onNavigate,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	onShowTheme: () => void;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="experience"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<UiSection
				ui={state.ui}
				onChange={(patch) => state.setUi((ui) => ({ ...ui, ...patch }))}
				voiceHotkey={state.voice.enabled ? state.voice.hotkey : ""}
			/>
			<div className="flex min-w-0 flex-col items-start gap-3 border border-border bg-card p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between">
				<div className="min-w-0">
					<div className="text-sm">Custom theme</div>
					<p className="mt-0.5 break-words text-xs text-muted-foreground">
						Edit desktop and mobile palettes on their own live-preview screen.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowTheme}
					className="min-h-11 max-w-full shrink-0 whitespace-normal border border-border px-3 py-1.5 text-center text-[10px] tracking-widest uppercase hover:bg-accent lg:min-h-0"
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
				codexProvider={initial.providers.find(
					(provider) => provider.id === "codex",
				)}
				codexModel={state.codex.model}
			/>
			<SessionSection view="privacy" />
		</>
	);
}

function IntegrationsCategory({
	state,
	initial,
	onShowApps,
	onShowUmbod,
	onShowCatalog,
	navigation,
	onNavigate,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
	onShowApps: () => void;
	onShowUmbod: () => void;
	onShowCatalog: () => void;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="integrations"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<div className="flex min-w-0 flex-col items-start gap-3 border border-border bg-card p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between">
				<div className="min-w-0">
					<div className="text-sm">Apps and Connectors</div>
					<p className="mt-0.5 break-words text-xs text-muted-foreground">
						Inspect provider-native app readiness, authentication, and MCP
						health separately from plugin packages.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowApps}
					className="min-h-11 max-w-full shrink-0 whitespace-normal border border-border px-3 py-1.5 text-center text-[10px] tracking-widest uppercase hover:bg-accent lg:min-h-0"
				>
					Open Apps
				</button>
			</div>
			<McpSection vaultPath={state.vault.path} />
			<CliProxySection
				config={initial.cliproxy}
				initialInfo={initial.cliProxyInfo}
			/>
			<div className="flex min-w-0 flex-col items-start gap-3 border border-border bg-card p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between">
				<div className="min-w-0">
					<div className="text-sm">Umbod policy</div>
					<p className="mt-0.5 break-words text-xs text-muted-foreground">
						Configure enforcement, generate hooks, and inspect tool calls.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowUmbod}
					className="min-h-11 max-w-full shrink-0 whitespace-normal border border-border px-3 py-1.5 text-center text-[10px] tracking-widest uppercase hover:bg-accent lg:min-h-0"
				>
					Open Umbod
				</button>
			</div>
			<div className="flex min-w-0 flex-col items-start gap-3 border border-border bg-card p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between">
				<div className="min-w-0">
					<div className="text-sm">OpenCode and ACP agents</div>
					<p className="mt-0.5 break-words text-xs text-muted-foreground">
						Set up the featured OpenCode connection or browse other Agent Client
						Protocol integrations.
					</p>
				</div>
				<button
					type="button"
					onClick={onShowCatalog}
					className="min-h-11 max-w-full shrink-0 whitespace-normal border border-border px-3 py-1.5 text-center text-[10px] tracking-widest uppercase hover:bg-accent lg:min-h-0"
				>
					Open integrations
				</button>
			</div>
		</>
	);
}

function ProviderAppsPage({
	providers,
	cwd,
	onBack,
}: {
	providers: SettingsInitial["providers"];
	cwd: string;
	onBack: () => void;
}) {
	const appProviders = providers.filter(
		(provider) => provider.available && provider.capabilities?.appCatalog,
	);
	const [providerId, setProviderId] = useState(appProviders[0]?.id ?? "");
	useEffect(() => {
		if (appProviders.some((provider) => provider.id === providerId)) return;
		setProviderId(appProviders[0]?.id ?? "");
	}, [appProviders, providerId]);
	const provider = appProviders.find(
		(candidate) => candidate.id === providerId,
	);
	return (
		<>
			<NestedBackButton label="Integrations" onClick={onBack} />
			<PageIntro
				id="forge-view-apps"
				headingLevel={1}
				title="Apps and Connectors"
				description="Inspect provider-native app installation, configuration, authentication, usability, and MCP health."
			/>
			{appProviders.length > 1 && (
				<select
					value={providerId}
					onChange={(event) => setProviderId(event.target.value)}
					aria-label="Apps provider"
					className="w-full max-w-sm border border-border bg-input px-2.5 py-1.5 text-xs"
				>
					{appProviders.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.label}
						</option>
					))}
				</select>
			)}
			{provider ? (
				<ProviderAppsCatalog
					providerId={provider.id}
					providerLabel={provider.label}
					cwd={cwd}
				/>
			) : (
				<div className="border border-border bg-card p-6 text-sm text-muted-foreground">
					No available provider advertises an Apps catalog through Hlid.
				</div>
			)}
		</>
	);
}

function DeveloperCategory({
	developerView,
	onDeveloperView,
	navigation,
	onNavigate,
}: {
	developerView: DeveloperView;
	onDeveloperView: (view: DeveloperView) => void;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	function handleTabKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		view: DeveloperView,
	) {
		const currentIndex = DEVELOPER_TABS.findIndex(
			([candidate]) => candidate === view,
		);
		let nextIndex: number;
		switch (event.key) {
			case "ArrowLeft":
				nextIndex =
					(currentIndex - 1 + DEVELOPER_TABS.length) % DEVELOPER_TABS.length;
				break;
			case "ArrowRight":
				nextIndex = (currentIndex + 1) % DEVELOPER_TABS.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = DEVELOPER_TABS.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const nextView = DEVELOPER_TABS[nextIndex][0];
		onDeveloperView(nextView);
		document.getElementById(`forge-tab-${nextView}`)?.focus();
	}

	return (
		<>
			<CategoryIntro
				category="developer"
				navigation={navigation}
				onNavigate={onNavigate}
				showSections={false}
			/>
			<div
				className="inline-flex border border-border bg-card p-1"
				role="tablist"
				aria-label="Developer tools"
			>
				{DEVELOPER_TABS.map(([view, label]) => (
					<button
						key={view}
						id={`forge-tab-${view}`}
						type="button"
						role="tab"
						onClick={() => onDeveloperView(view)}
						onKeyDown={(event) => handleTabKeyDown(event, view)}
						aria-selected={developerView === view}
						aria-controls={`forge-view-${view}`}
						tabIndex={developerView === view ? 0 : -1}
						className={`min-h-11 px-3 py-2 text-[10px] tracking-widest uppercase transition-colors lg:min-h-0 lg:py-1.5 ${
							developerView === view
								? "bg-primary/10 text-primary"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						}`}
					>
						{label}
					</button>
				))}
			</div>
			<div
				id={`forge-view-${developerView}`}
				role="tabpanel"
				tabIndex={-1}
				aria-labelledby={`forge-tab-${developerView}`}
				className="scroll-mt-20 focus-visible:outline-none"
			>
				{developerView === "events" ? (
					<EventLogSection />
				) : developerView === "api" ? (
					<ApiSection />
				) : (
					<PricingSection />
				)}
			</div>
		</>
	);
}

function ExtensionsCategory({
	navigation,
	onNavigate,
}: {
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="extensions"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<ExtensionsSection destination={navigation.setting} />
		</>
	);
}

function AdvancedCategory({
	navigation,
	onNavigate,
}: {
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
}) {
	return (
		<>
			<CategoryIntro
				category="advanced"
				navigation={navigation}
				onNavigate={onNavigate}
			/>
			<SystemSection view="advanced" />
			<SessionSection view="advanced" />
		</>
	);
}

function CategoryContent({
	category,
	navigation,
	onNavigate,
	state,
	initial,
	showCatalog,
	onShowCatalog,
	showApps,
	onShowApps,
	showUmbod,
	onShowUmbod,
	showTheme,
	onShowTheme,
	themeTarget,
	onThemeTarget,
	developerView,
	onDeveloperView,
	onRefreshProviders,
	onDiscoverAcpModels,
}: {
	category: Category;
	navigation: ForgeNavigationState;
	onNavigate: (navigation: ForgeNavigationState) => void;
	state: SettingsFormState;
	initial: SettingsInitial;
	showCatalog: boolean;
	onShowCatalog: (show: boolean) => void;
	showApps: boolean;
	onShowApps: (show: boolean) => void;
	showUmbod: boolean;
	onShowUmbod: (show: boolean) => void;
	showTheme: boolean;
	onShowTheme: (show: boolean) => void;
	themeTarget: ThemeTarget;
	onThemeTarget: (target: ThemeTarget) => void;
	developerView: DeveloperView;
	onDeveloperView: (view: DeveloperView) => void;
	onRefreshProviders: (providerId: string) => void | Promise<void>;
	onDiscoverAcpModels?: (id: string) => Promise<ProviderInfo["models"]>;
}) {
	if (category === "integrations" && showApps)
		return (
			<ProviderAppsPage
				providers={initial.providers}
				cwd={state.vault.path || initial.cwd}
				onBack={() => onShowApps(false)}
			/>
		);
	if (category === "integrations" && showCatalog)
		return (
			<AcpCatalogPage
				state={state}
				initial={initial}
				onBack={() => onShowCatalog(false)}
				onRefreshProviders={onRefreshProviders}
				onDiscoverAcpModels={onDiscoverAcpModels}
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
			return (
				<OverviewCategory navigation={navigation} onNavigate={onNavigate} />
			);
		case "workspace":
			return (
				<WorkspaceCategory
					state={state}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "agents":
			return (
				<AgentsCategory
					state={state}
					initial={initial}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "access":
			return (
				<AccessCategory
					state={state}
					initial={initial}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "experience":
			return (
				<ExperienceCategory
					state={state}
					initial={initial}
					onShowTheme={() => onShowTheme(true)}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "integrations":
			return (
				<IntegrationsCategory
					state={state}
					initial={initial}
					onShowApps={() => onShowApps(true)}
					onShowUmbod={() => onShowUmbod(true)}
					onShowCatalog={() => onShowCatalog(true)}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "extensions":
			return (
				<ExtensionsCategory navigation={navigation} onNavigate={onNavigate} />
			);
		case "developer":
			return (
				<DeveloperCategory
					developerView={developerView}
					onDeveloperView={onDeveloperView}
					navigation={navigation}
					onNavigate={onNavigate}
				/>
			);
		case "advanced":
			return (
				<AdvancedCategory navigation={navigation} onNavigate={onNavigate} />
			);
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
			className="min-h-5 min-w-0 max-w-full break-words text-[10px] tracking-wider uppercase"
			aria-live="polite"
		>
			{state.saving && <span className="text-muted-foreground">Saving…</span>}
			{!state.saving && state.error && (
				<span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 text-destructive">
					<span className="min-w-0 break-words [overflow-wrap:anywhere]">
						{state.error}
					</span>
					<button
						type="button"
						onClick={() => void state.save()}
						className="shrink-0 border border-destructive/40 px-1.5 py-0.5 hover:bg-destructive/10"
					>
						Retry save
					</button>
				</span>
			)}
			{!state.saving && !state.error && state.dirty && (
				<span className="text-status-warning">Unsaved changes…</span>
			)}
			{!state.saving && !state.error && !state.dirty && state.warning && (
				<span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 text-status-warning">
					{state.savedMsg === "restart" && (
						<button
							type="button"
							onClick={onRestartRequired}
							className="shrink-0 border border-status-warning/40 px-1.5 py-0.5 hover:bg-status-warning/10"
						>
							Restart required
						</button>
					)}
					{state.acpRuntimePending && (
						<button
							type="button"
							onClick={() => void state.save()}
							className="shrink-0 border border-status-warning/40 px-1.5 py-0.5 hover:bg-status-warning/10"
						>
							Retry ACP sync
						</button>
					)}
					<span className="min-w-0 break-words [overflow-wrap:anywhere]">
						{state.savedMsg === "restart" ? "Changes saved. " : "Saved. "}
						{state.warning}
					</span>
				</span>
			)}
			{!state.dirty && !state.warning && state.savedMsg === "saved" && (
				<span className="text-status-success">Saved</span>
			)}
			{!state.warning && state.savedMsg === "restart" && (
				<span className="inline-flex items-center gap-2 text-status-warning">
					<button
						type="button"
						onClick={onRestartRequired}
						className="border border-status-warning/40 px-1.5 py-0.5 hover:bg-status-warning/10"
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
			className="max-w-full whitespace-normal break-words border border-status-warning/40 px-2 py-1 text-left text-[10px] tracking-wider text-status-warning hover:bg-status-warning/10 uppercase"
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
	onRefreshProviderOptions = onRetryInventory,
	onDiscoverAcpModels,
	navigation: controlledNavigation,
	onNavigationChange,
}: {
	initial: SettingsInitial;
	state: SettingsFormState;
	inventoryStatus?: "loading" | "ready" | "unavailable";
	onRetryInventory?: () => void | Promise<void>;
	onRefreshProviderOptions?: (providerId: string) => void | Promise<void>;
	onDiscoverAcpModels?: (id: string) => Promise<ProviderInfo["models"]>;
	/** URL-backed navigation supplied by the Forge route. */
	navigation?: ForgeNavigationState;
	/** Receives category, section, setting, and nested-view navigation changes. */
	onNavigationChange?: (navigation: ForgeNavigationState) => void;
}) {
	const [localNavigation, setLocalNavigation] = useState<ForgeNavigationState>({
		category: "overview",
	});
	const [search, setSearch] = useState("");
	const [focusRequest, setFocusRequest] = useState(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const handledInitialFocus = useRef(false);
	const navigation = controlledNavigation
		? normalizeForgeNavigation(controlledNavigation)
		: localNavigation;
	const category = navigation.category;
	const showCatalog = category === "integrations" && navigation.view === "acp";
	const showApps = category === "integrations" && navigation.view === "apps";
	const showUmbod = category === "integrations" && navigation.view === "umbod";
	const showTheme = category === "experience" && navigation.view === "theme";
	const themeTarget: ThemeTarget = navigation.target ?? "desktop";
	const developerView: DeveloperView =
		category === "developer" &&
		(navigation.view === "api" || navigation.view === "pricing")
			? navigation.view
			: "events";
	const searchQuery = search.trim();
	const vaultProvider = state.claude?.vaultProvider ?? "";
	const voiceInputProvider = state.voice?.input_provider;
	const searchMatches = useMemo(() => {
		return searchForgeDestinations(searchQuery, Number.MAX_SAFE_INTEGER)
			.filter((destination) =>
				isSearchDestinationAvailable(
					destination,
					vaultProvider,
					voiceInputProvider,
				),
			)
			.slice(0, SEARCH_RESULT_LIMIT + 1);
	}, [searchQuery, vaultProvider, voiceInputProvider]);
	const searchResults = searchMatches.slice(0, SEARCH_RESULT_LIMIT);
	const searchResultsTruncated = searchMatches.length > SEARCH_RESULT_LIMIT;

	function navigate(next: ForgeNavigationState) {
		const normalized = normalizeForgeNavigation(next);
		if (!controlledNavigation) setLocalNavigation(normalized);
		setFocusRequest((request) => request + 1);
		// Queue every component-local update before handing navigation to the
		// router. A route transition can synchronously replace this render tree.
		onNavigationChange?.(normalized);
	}

	function choose(next: Category) {
		setSearch("");
		navigate({ category: next });
	}

	const navigationFocusId = getForgeNavigationFocusId(navigation);
	const focusNavigation = useMemo<ForgeNavigationState>(
		() => ({
			category: navigation.category,
			...(navigation.section ? { section: navigation.section } : {}),
			...(navigation.setting ? { setting: navigation.setting } : {}),
			...(navigation.view ? { view: navigation.view } : {}),
			...(navigation.target ? { target: navigation.target } : {}),
		}),
		[
			navigation.category,
			navigation.section,
			navigation.setting,
			navigation.view,
			navigation.target,
		],
	);
	const isDefaultOverview =
		navigation.category === "overview" &&
		!navigation.section &&
		!navigation.setting &&
		!navigation.view;
	const focusRequestKey = `${navigationFocusId ?? ""}:${navigation.setting ?? ""}:${focusRequest}`;
	useEffect(() => {
		// A repeated selection of the same destination still needs a fresh alignment.
		void focusRequestKey;
		if (!handledInitialFocus.current) {
			handledInitialFocus.current = true;
			if (isDefaultOverview) return;
		}
		let focused = false;
		const focusDestination = () => {
			const target = findRenderedSettingTarget(
				focusNavigation,
				navigationFocusId,
			);
			if (target) {
				target.scrollIntoView?.({ block: "start" });
				if (!focused) {
					target.focus({ preventScroll: true });
					focused = true;
				}
				return;
			}
			scrollRef.current?.scrollTo?.({ top: 0 });
		};
		let firstFrame: number | undefined;
		let secondFrame: number | undefined;
		if (typeof window.requestAnimationFrame === "function") {
			firstFrame = window.requestAnimationFrame(() => {
				secondFrame = window.requestAnimationFrame(focusDestination);
			});
		}
		const settleTimeout = window.setTimeout(focusDestination, 200);
		return () => {
			if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
			if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
			window.clearTimeout(settleTimeout);
		};
	}, [focusRequestKey, isDefaultOverview, focusNavigation, navigationFocusId]);

	function chooseSearchResult(destination: ForgeSearchDestination) {
		setSearch("");
		navigate(destination.navigation);
	}

	function setNestedView(
		view: Extract<ForgeView, "apps" | "umbod" | "acp" | "theme">,
		show: boolean,
	) {
		if (!show) {
			navigate({
				category: view === "theme" ? "experience" : "integrations",
			});
			return;
		}
		const section =
			view === "apps"
				? "apps-connectors"
				: view === "acp"
					? "opencode-acp"
					: view === "theme"
						? "custom-theme"
						: "umbod";
		navigate({
			category: view === "theme" ? "experience" : "integrations",
			section,
			view,
		});
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
		setSearch("");
		navigate({
			category: "advanced",
			section: "danger-zone",
			setting: "restart",
		});
	}
	return (
		<div className="flex h-full min-h-0">
			<SectionRail
				items={FORGE_CATEGORIES.map((item) => ({
					id: item.id,
					label: item.label,
					group: item.group,
				}))}
				activeId={category}
				onSelect={(id) => choose(id as Category)}
				label="Forge categories"
				useAriaCurrent
				visibleFrom="lg"
			/>
			<div className="flex-1 min-w-0 flex flex-col">
				<PageHeader eyebrow="Forge">
					<select
						value={category}
						onChange={(e) => choose(e.target.value as Category)}
						aria-label="Forge category"
						className="min-h-11 min-w-0 flex-1 border border-border bg-input px-2 py-2 text-xs lg:hidden"
					>
						{FORGE_CATEGORIES.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
					<div className="relative order-last w-full min-w-0 lg:order-none lg:ml-auto lg:w-auto lg:max-w-sm lg:flex-[1_1_16rem]">
						<input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setSearch("");
							}}
							placeholder="Search settings"
							aria-label="Search settings"
							className="min-h-11 w-full min-w-0 border border-border bg-input px-3 py-2 pr-10 text-xs focus:border-primary/50 focus:outline-none lg:min-h-0 lg:py-1.5"
						/>
						{searchQuery && (
							<button
								type="button"
								onClick={() => setSearch("")}
								aria-label="Clear setting search"
								className="absolute inset-y-0 right-0 min-w-10 px-2 text-sm text-muted-foreground hover:text-foreground"
							>
								×
							</button>
						)}
					</div>
					<InventoryStatus
						status={inventoryStatus}
						onRetry={onRetryInventory}
					/>
					<SaveStatus state={state} onRestartRequired={showRestartControls} />
				</PageHeader>
				<div
					ref={scrollRef}
					data-forge-touch-surface
					data-scroll-restoration-id={
						ROUTE_SCROLL_RESTORATION_IDS.forgeSettings
					}
					data-scroll-to-top="route"
					className="flex-1 overflow-auto"
				>
					<div className="@container mx-auto max-w-[1000px] min-w-0 space-y-6 px-4 pt-4 pb-20 sm:px-6 sm:pt-6 md:pb-6">
						{searchQuery ? (
							<SettingsSearchResults
								query={searchQuery}
								results={searchResults}
								truncated={searchResultsTruncated}
								onChoose={chooseSearchResult}
								onClear={() => setSearch("")}
							/>
						) : (
							<CategoryContent
								category={category}
								navigation={navigation}
								onNavigate={navigate}
								state={state}
								initial={initial}
								showCatalog={showCatalog}
								onShowCatalog={(show) => setNestedView("acp", show)}
								showApps={showApps}
								onShowApps={(show) => setNestedView("apps", show)}
								showUmbod={showUmbod}
								onShowUmbod={(show) => setNestedView("umbod", show)}
								showTheme={showTheme}
								onShowTheme={(show) => setNestedView("theme", show)}
								themeTarget={themeTarget}
								onThemeTarget={(target) => navigate({ ...navigation, target })}
								developerView={developerView}
								onDeveloperView={(view) =>
									navigate({ category: "developer", view })
								}
								onRefreshProviders={onRefreshProviderOptions}
								onDiscoverAcpModels={onDiscoverAcpModels}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
