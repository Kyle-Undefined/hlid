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
import { getConfig } from "#/config";
import { useCockpitLiveData } from "#/hooks/useCockpitLiveData";
import { useCockpitRun } from "#/hooks/useCockpitRun";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useMergedSkills } from "#/hooks/useMergedSkills";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVoiceInput } from "#/hooks/useVoiceInput";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import { insertAtSelection, resizeComposer } from "#/lib/composer";
import { fmtModel } from "#/lib/formatters";
import { getAgentListFn } from "#/lib/serverFns/agents";
import { getCockpitData } from "#/lib/serverFns/cockpit";
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
			providerUsages,
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
			loadProviderUsages(),
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
			providerUsages,
			thirtyDayStats,
			agentList,
			activeSession,
			voiceInfo,
		};
	},
	component: CockpitPage,
});

/** Composer-local state: prompt text, active skill, run toggles, focus plumbing. */
function useCockpitComposer() {
	const [prompt, setPrompt] = useState("");
	const [selectedAgentPath, setSelectedAgentPath] = useState("");
	const [activeSkill, setActiveSkill] = useState<ActiveCockpitSkill | null>(
		null,
	);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
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
		el.selectionStart = el.selectionEnd = 0;
	}, [activeSkill]);

	function handleSkillSelect(skill: Skill) {
		pendingSkillFocusRef.current = true;
		setPrompt("");
		setActiveSkill({
			name: skill.name,
			section: skill.section,
			filePath: skill.filePath,
		});
	}

	function handleClear() {
		setPrompt("");
		setActiveSkill(null);
	}

	return {
		prompt,
		setPrompt,
		selectedAgentPath,
		setSelectedAgentPath,
		activeSkill,
		setActiveSkill,
		background,
		setBackground,
		sameSession,
		setSameSession,
		textareaRef,
		fileInputRef,
		handleSkillSelect,
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
	allSkills,
	navigate,
}: {
	composer: CockpitComposer;
	live: CockpitLive;
	upload: CockpitUpload;
	allSkills: ReturnType<typeof useMergedSkills>;
	navigate: CockpitNavigate;
}) {
	const isRunning =
		live.wsStatus === "connected" && live.sessionState === "running";
	return useCockpitRun({
		prompt: composer.prompt,
		activeSkill: composer.activeSkill,
		allSkills,
		wsStatus: live.wsStatus,
		sameSession: composer.sameSession,
		attachSessionIdRef: upload.uploadSessionIdRef,
		pendingAttachments: upload.pendingAttachments,
		clearPendingAttachments: upload.clearPending,
		isRunning,
		selectedAgentPath: composer.selectedAgentPath,
		background: composer.background,
		model: live.model,
		send: live.send,
		setRunError: live.setRunError,
		setPrompt: composer.setPrompt,
		setActiveSkill: composer.setActiveSkill,
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
	allSkills,
	onRun,
}: {
	config: Awaited<ReturnType<typeof getConfig>>;
	composer: CockpitComposer;
	live: CockpitLive;
	upload: CockpitUpload;
	voice: ReturnType<typeof useVoiceInput>;
	agentList: Awaited<ReturnType<typeof getAgentListFn>>;
	allSkills: ReturnType<typeof useMergedSkills>;
	onRun: () => void;
}) {
	const picker = useSlashPicker(
		composer.prompt,
		allSkills,
		composer.activeSkill,
	);
	const isConnected = live.wsStatus === "connected";
	const isRunning = isConnected && live.sessionState === "running";
	const canRun =
		(!!composer.activeSkill || composer.prompt.trim().length > 0) &&
		isConnected;
	return (
		<CockpitPrompt
			config={config}
			prompt={composer.prompt}
			setPrompt={composer.setPrompt}
			activeSkill={composer.activeSkill}
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
			onSkillSelect={composer.handleSkillSelect}
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
	const composer = useCockpitComposer();
	const live = useCockpitLiveData({
		recentSessions: loader.recentSessions,
		agg: loader.statsData.agg,
		weeklyStats: loader.weeklyStats,
		thirtyDayStats: loader.thirtyDayStats,
		activeSession: loader.activeSession,
		mcpServers: loader.mcpServers,
	});
	const upload = useFileUpload({ agentCwd: composer.selectedAgentPath });
	const allSkills = useMergedSkills(data.skills, live.sdkSlashCommands);
	const skillGroups = useMemo(
		() => groupSkills(allSkills, data.sectionOrder),
		[allSkills, data.sectionOrder],
	);
	const handleRun = useCockpitRunWiring({
		composer,
		live,
		upload,
		allSkills,
		navigate,
	});
	const voice = useCockpitVoice(config, loader.voiceInfo, composer, handleRun);

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

	const modelShort = live.model ? fmtModel(live.model) : null;
	const onRunClick = (id: string) =>
		navigate({ to: "/raven", search: { session: id, agent: undefined } });

	return (
		<div className="flex flex-col md:h-full">
			<CockpitHeader config={config} modelShort={modelShort} />
			<CockpitTopPanels
				live={live}
				liveStats={liveStats}
				initialProviderUsages={loader.providerUsages}
				navigate={navigate}
			/>

			{/* Two-column body */}
			<div className="flex md:flex-1 md:overflow-hidden">
				{/* Main column */}
				<div className="flex flex-col flex-1 md:overflow-auto">
					<CockpitPromptWiring
						config={config}
						composer={composer}
						live={live}
						upload={upload}
						voice={voice}
						agentList={agentList}
						allSkills={allSkills}
						onRun={() => void handleRun()}
					/>

					<CockpitRunError error={live.runError} />
					<CockpitSkills
						hasSkills={data.skills.length > 0}
						groups={skillGroups}
						activeSkill={composer.activeSkill}
						onSelect={composer.handleSkillSelect}
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
