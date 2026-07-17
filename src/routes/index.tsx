import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	CockpitHeader,
	CockpitRunError,
	CockpitSkills,
} from "#/components/cockpit/CockpitContent";
import {
	type ActiveCockpitSkill,
	CockpitPrompt,
} from "#/components/cockpit/CockpitPrompt";
import {
	MobileRunsPanel,
	RecentRunsSidebar,
} from "#/components/cockpit/CockpitSidebar";
import { McpPanel } from "#/components/cockpit/McpPanel";
import { MobileContextBand } from "#/components/cockpit/MobileContextBand";
import { MobileStatsPanel } from "#/components/cockpit/MobileStatsPanel";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { PrivacyMask } from "#/components/PrivacyMask";
import { ProviderUsageStrip } from "#/components/usage/ProviderUsageStrip";
import { RoutinesWindowSection } from "#/components/usage/UsageWindowSections";
import { FirstRunWizard } from "#/components/wizard/FirstRunWizard";
import { useCockpitLiveData } from "#/hooks/useCockpitLiveData";
import { isCockpitQueueTarget, useCockpitRun } from "#/hooks/useCockpitRun";
import { useCommands } from "#/hooks/useCommands";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVoiceInput } from "#/hooks/useVoiceInput";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import {
	addCommandSelection,
	type CommandDescriptor,
	skillCommand,
} from "#/lib/commands";
import { insertAtSelection, resizeComposer } from "#/lib/composer";
import { fmtModel } from "#/lib/formatters";
import {
	configuredVaultModel,
	resolveActiveProviderId,
} from "#/lib/providerOptions";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitData } from "#/lib/serverFns/cockpit";
import { getConfig } from "#/lib/serverFns/config";
import { getMcpServersFn } from "#/lib/serverFns/mcp";
import { loadProviderUsages } from "#/lib/serverFns/providers";
import { getActiveSessionRowFn } from "#/lib/serverFns/sessions";
import {
	getCockpitStatsFn,
	getRecentSessionsFn,
	getThirtyDayStatsFn,
	getWeeklyStatsFn,
} from "#/lib/serverFns/stats";
import { getVoiceInfoFn } from "#/lib/serverFns/voice";
import { groupSkills, type Skill } from "#/lib/skills";

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
	loader: async () => {
		const [
			config,
			data,
			recentSessions,
			statsData,
			mcpServers,
			weeklyStats,
			thirtyDayStats,
			agentList,
			activeSession,
			voiceInfo,
		] = await Promise.all([
			getConfig(),
			getCockpitData(),
			getRecentSessionsFn(),
			getCockpitStatsFn(),
			getMcpServersFn(),
			getWeeklyStatsFn(),
			getThirtyDayStatsFn(),
			getAgentListFn(),
			getActiveSessionRowFn(),
			getVoiceInfoFn(),
		]);
		return {
			config,
			data,
			recentSessions,
			statsData,
			mcpServers,
			weeklyStats,
			// Provider discovery is optional dashboard decoration and can involve a
			// busy host CLI. Let the mounted usage strip hydrate it in the background
			// so navigating to Watch never waits on /providers.
			providerUsages: [],
			thirtyDayStats,
			agentList,
			activeSession,
			voiceInfo,
		};
	},
	component: CockpitPage,
});

/** Composer-local state: prompt text, active skill, run toggles, focus plumbing. */
function useCockpitComposer(initialPlanHtml: boolean) {
	const [prompt, setPrompt] = useState("");
	const [selectedAgentPath, setSelectedAgentPath] = useState("");
	const [activeSkills, setActiveSkills] = useState<ActiveCockpitSkill[]>([]);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
	const [planMode, setPlanMode] = useState(false);
	const [planHtml, setPlanHtml] = useState(initialPlanHtml);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt length triggers resize
	useEffect(() => {
		resizeComposer(textareaRef.current, 280);
	}, [prompt]);

	// Focus textarea after skill activation (useEffect avoids setTimeout race)
	const pendingSkillFocusRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSkill is the trigger dep
	useEffect(() => {
		if (!pendingSkillFocusRef.current) return;
		pendingSkillFocusRef.current = false;
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		el.selectionStart = el.selectionEnd = el.value.length;
	}, [activeSkills]);

	function handleCommandSelect(
		command: CommandDescriptor,
		remainingPrompt = "",
		providerId?: string,
	) {
		pendingSkillFocusRef.current = true;
		setPrompt(remainingPrompt);
		setActiveSkills((selected) =>
			addCommandSelection(selected, command, providerId),
		);
	}

	function handleSkillSelect(skill: Skill, providerId?: string) {
		handleCommandSelect(skillCommand(skill), "", providerId);
	}

	function handleClear() {
		setPrompt("");
		setActiveSkills([]);
	}

	return {
		prompt,
		setPrompt,
		selectedAgentPath,
		setSelectedAgentPath,
		activeSkills,
		setActiveSkills,
		background,
		setBackground,
		sameSession,
		setSameSession,
		planMode,
		setPlanMode,
		planHtml,
		setPlanHtml,
		textareaRef,
		fileInputRef,
		handleSkillSelect,
		handleCommandSelect,
		handleClear,
	};
}

type CockpitComposer = ReturnType<typeof useCockpitComposer>;
type CockpitLive = ReturnType<typeof useCockpitLiveData>;
type CockpitUpload = ReturnType<typeof useFileUpload>;
type CockpitNavigate = ReturnType<typeof useNavigate>;

function useCockpitRunWiring({
	composer,
	live,
	upload,
	commands,
	navigate,
	configuredModel,
	vaultPath,
}: {
	composer: CockpitComposer;
	live: CockpitLive;
	upload: CockpitUpload;
	commands: CommandDescriptor[];
	navigate: CockpitNavigate;
	configuredModel: string | null;
	vaultPath: string;
}) {
	return useCockpitRun({
		prompt: composer.prompt,
		activeSkills: composer.activeSkills,
		commands,
		wsStatus: live.wsStatus,
		sameSession: composer.sameSession,
		planMode: composer.planMode,
		planHtml: composer.planHtml,
		attachSessionIdRef: upload.uploadSessionIdRef,
		pendingAttachments: upload.pendingAttachments,
		clearPendingAttachments: upload.clearPending,
		selectedAgentPath: composer.selectedAgentPath,
		vaultPath,
		background: composer.background,
		model: configuredModel,
		send: live.send,
		setRunError: live.setRunError,
		setPrompt: composer.setPrompt,
		setActiveSkills: composer.setActiveSkills,
		setRecentRuns: live.setRecentRuns,
		setThirtyDayStats: live.setThirtyDayStats,
		setWeeklyStats: live.setWeeklyStats,
		navigateToRaven: (sessionId, agent) => {
			navigate({ to: "/raven", search: { session: sessionId, agent } });
		},
	});
}

function useCockpitVoice(
	config: Awaited<ReturnType<typeof getConfig>>,
	initialVoiceInfo: Awaited<ReturnType<typeof getVoiceInfoFn>>,
	composer: CockpitComposer,
	handleRun: (overrideText?: string) => Promise<void>,
) {
	const { prompt, setPrompt, textareaRef } = composer;
	return useVoiceInput({
		config: config.voice,
		initialInfo: initialVoiceInfo,
		onTranscription: (text) => {
			if (config.voice.auto_send) {
				void handleRun(text);
				return;
			}
			const el = textareaRef.current;
			const start = el?.selectionStart ?? prompt.length;
			const end = el?.selectionEnd ?? prompt.length;
			setPrompt(insertAtSelection(prompt, text, start, end));
			requestAnimationFrame(() => textareaRef.current?.focus());
		},
	});
}

/** Full-width panels above the two-column body (usage, graphs, MCP, mobile sections). */
function CockpitTopPanels({
	live,
	liveStats,
	initialProviderUsages,
	navigate,
}: {
	live: CockpitLive;
	liveStats: ReturnType<typeof useWsLiveStats>;
	initialProviderUsages: Awaited<ReturnType<typeof loadProviderUsages>>;
	navigate: CockpitNavigate;
}) {
	const isConnected = live.wsStatus === "connected";
	return (
		<>
			{/* Usage windows */}
			<ProviderUsageStrip
				initial={initialProviderUsages}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={live.rateLimit}
				fetchFn={loadProviderUsages}
				tail={<RoutinesWindowSection />}
			/>

			{/* Mobile context band, shows context % when active */}
			<MobileContextBand stats={liveStats} />

			{/* 30-day activity graph */}
			<PrivacyMask>
				<ThirtyDayGraph data={live.thirtyDayStats} />
			</PrivacyMask>

			{/* Stats, desktop: right sidebar; mobile: collapsible section */}
			<MobileStatsPanel
				stats={liveStats}
				agg={live.agg}
				isConnected={isConnected}
			/>

			{/* MCP panel */}
			<McpPanel servers={live.mcpServers} />

			{/* Mobile: collapsible recent runs + this week graph */}
			<MobileRunsPanel
				runs={live.recentRuns}
				weeklyStats={live.weeklyStats}
				onRunClick={(id) =>
					navigate({ to: "/raven", search: { session: id, agent: undefined } })
				}
			/>
		</>
	);
}

function CockpitPromptWiring({
	config,
	composer,
	live,
	upload,
	voice,
	agentList,
	commands,
	onRun,
}: {
	config: Awaited<ReturnType<typeof getConfig>>;
	composer: CockpitComposer;
	live: CockpitLive;
	upload: CockpitUpload;
	voice: ReturnType<typeof useVoiceInput>;
	agentList: Awaited<ReturnType<typeof getAgentListFn>>;
	commands: CommandDescriptor[];
	onRun: () => void;
}) {
	const commandProviderId = resolveActiveProviderId(
		agentList,
		composer.selectedAgentPath || undefined,
		config.vault_provider,
	);
	useEffect(() => {
		composer.setActiveSkills((selected) => {
			const compatible = selected.filter(
				(command) =>
					!command.providerId || command.providerId === commandProviderId,
			);
			return compatible.length === selected.length ? selected : compatible;
		});
	}, [commandProviderId, composer.setActiveSkills]);
	const picker = useSlashPicker(
		composer.prompt,
		commands,
		composer.activeSkills,
		commandProviderId,
	);
	const isConnected = live.wsStatus === "connected";
	const isRunning =
		isConnected &&
		isCockpitQueueTarget({
			sameSession: composer.sameSession,
			sessionId: live.liveActiveSession?.id,
			selectedAgentPath: composer.selectedAgentPath,
			vaultPath: config.vault.path,
			sessions: live.sessionsStatus,
		});
	const canRun =
		(composer.activeSkills.length > 0 ||
			composer.prompt.trim().length > 0 ||
			upload.pendingAttachments.length > 0) &&
		upload.uploadingCount === 0 &&
		isConnected;
	return (
		<CockpitPrompt
			config={config}
			prompt={composer.prompt}
			setPrompt={composer.setPrompt}
			activeSkills={composer.activeSkills}
			isConnected={isConnected}
			isRunning={isRunning}
			canRun={canRun}
			selectedAgentPath={composer.selectedAgentPath}
			setSelectedAgentPath={composer.setSelectedAgentPath}
			agentList={agentList}
			background={composer.background}
			setBackground={composer.setBackground}
			sameSession={composer.sameSession}
			setSameSession={composer.setSameSession}
			planMode={composer.planMode}
			setPlanMode={composer.setPlanMode}
			planHtml={composer.planHtml}
			setPlanHtml={composer.setPlanHtml}
			textareaRef={composer.textareaRef}
			fileInputRef={composer.fileInputRef}
			upload={{
				pendingAttachments: upload.pendingAttachments,
				uploadingCount: upload.uploadingCount,
				uploadError: upload.uploadError,
				uploadFiles: upload.uploadFiles,
				removePending: upload.removePending,
			}}
			voice={voice}
			picker={{
				open: picker.isOpen,
				items: picker.items,
				index: picker.selectedIndex,
				navigate: picker.navigate,
				close: picker.close,
			}}
			onSkillSelect={(command) =>
				composer.handleCommandSelect(
					command,
					picker.promptWithoutQuery,
					commandProviderId,
				)
			}
			onClearSkill={(commandId) => {
				composer.setActiveSkills((selected) =>
					selected.filter((command) => command.id !== commandId),
				);
				composer.textareaRef.current?.focus();
			}}
			onClear={composer.handleClear}
			onRun={onRun}
		/>
	);
}

function CockpitPage() {
	const loader = Route.useLoaderData();
	const { config, data, agentList } = loader;
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useWsLiveStats();
	const composer = useCockpitComposer(config.ui.html_plans ?? false);
	const live = useCockpitLiveData(
		{
			recentSessions: loader.recentSessions,
			agg: loader.statsData.agg,
			weeklyStats: loader.weeklyStats,
			thirtyDayStats: loader.thirtyDayStats,
			activeSession: loader.activeSession,
			mcpServers: loader.mcpServers,
		},
		composer.selectedAgentPath || undefined,
	);
	const upload = useFileUpload({ agentCwd: composer.selectedAgentPath });
	const commandProviderId = resolveActiveProviderId(
		agentList,
		composer.selectedAgentPath || undefined,
		config.vault_provider,
	);
	const visibleSkills = useMemo(
		() =>
			data.skills.filter(
				(skill) => !skill.providerId || skill.providerId === commandProviderId,
			),
		[data.skills, commandProviderId],
	);
	const commands = useCommands(
		visibleSkills,
		live.sdkSlashCommandProviderId === commandProviderId
			? live.sdkSlashCommands
			: [],
		commandProviderId,
	);
	const skillGroups = useMemo(
		() => groupSkills(visibleSkills, data.sectionOrder),
		[visibleSkills, data.sectionOrder],
	);
	const vaultModel = configuredVaultModel(config);
	const configuredRunModel = composer.selectedAgentPath
		? (agentList.find((agent) => agent.path === composer.selectedAgentPath)
				?.model ?? vaultModel)
		: vaultModel;
	const handleRun = useCockpitRunWiring({
		composer,
		live,
		upload,
		commands,
		navigate,
		configuredModel: configuredRunModel,
		vaultPath: config.vault.path,
	});
	const voice = useCockpitVoice(config, loader.voiceInfo, composer, handleRun);

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

	const modelShort = vaultModel ? fmtModel(vaultModel) : null;
	const onRunClick = (id: string) =>
		navigate({ to: "/raven", search: { session: id, agent: undefined } });

	return (
		<div className="flex min-w-0 flex-col overflow-x-hidden md:h-full">
			<CockpitHeader config={config} modelShort={modelShort} />
			<CockpitTopPanels
				live={live}
				liveStats={liveStats}
				initialProviderUsages={loader.providerUsages}
				navigate={navigate}
			/>

			{/* Two-column body */}
			<div className="flex min-w-0 md:flex-1 md:overflow-hidden">
				{/* Main column */}
				<div className="flex min-w-0 flex-1 flex-col md:overflow-auto">
					<CockpitPromptWiring
						config={config}
						composer={composer}
						live={live}
						upload={upload}
						voice={voice}
						agentList={agentList}
						commands={commands}
						onRun={() => void handleRun()}
					/>

					<CockpitRunError error={live.runError} />
					<CockpitSkills
						hasSkills={visibleSkills.length > 0}
						groups={skillGroups}
						activeSkills={composer.activeSkills}
						onSelect={(skill) =>
							composer.handleSkillSelect(skill, commandProviderId)
						}
					/>
				</div>

				{/* Recent runs sidebar, desktop only */}
				<RecentRunsSidebar
					runs={live.recentRuns}
					weeklyStats={live.weeklyStats}
					onRunClick={onRunClick}
					stats={liveStats}
					agg={live.agg}
					activeSession={live.liveActiveSession}
					className="hidden md:flex"
				/>
			</div>
		</div>
	);
}
