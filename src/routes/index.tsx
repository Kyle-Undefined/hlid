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
import {
	getActiveSessionRowFn,
	getAgentListFn,
	getCockpitData,
	getCockpitStatsFn,
	getMcpServersFn,
	getRecentSessionsFn,
	getThirtyDayStatsFn,
	getVoiceInfoFn,
	getWeeklyStatsFn,
	loadProviderUsages,
} from "#/lib/serverFns";
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

function CockpitPage() {
	const {
		config,
		data,
		recentSessions,
		statsData,
		mcpServers: initialMcpServers,
		weeklyStats: initialWeeklyStats,
		providerUsages: initialProviderUsages,
		thirtyDayStats: initialThirtyDayStats,
		agentList,
		activeSession,
		voiceInfo: initialVoiceInfo,
	} = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useWsLiveStats();
	const [prompt, setPrompt] = useState("");
	const [selectedAgentPath, setSelectedAgentPath] = useState("");
	const [activeSkill, setActiveSkill] = useState<ActiveCockpitSkill | null>(
		null,
	);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const {
		wsStatus,
		sessionState,
		model,
		send,
		recentRuns,
		setRecentRuns,
		agg,
		weeklyStats,
		setWeeklyStats,
		thirtyDayStats,
		setThirtyDayStats,
		liveActiveSession,
		mcpServers,
		sdkSlashCommands,
		runError,
		setRunError,
		rateLimit,
	} = useCockpitLiveData({
		recentSessions,
		agg: statsData.agg,
		weeklyStats: initialWeeklyStats,
		thirtyDayStats: initialThirtyDayStats,
		activeSession,
		mcpServers: initialMcpServers,
	});

	const {
		pendingAttachments,
		uploadingCount,
		uploadError,
		uploadSessionIdRef: attachSessionIdRef,
		uploadFiles,
		removePending,
		clearPending: clearPendingAttachments,
	} = useFileUpload({ agentCwd: selectedAgentPath });

	const allSkills = useMergedSkills(data.skills, sdkSlashCommands);

	const skillGroups = useMemo(
		() => groupSkills(allSkills, data.sectionOrder),
		[allSkills, data.sectionOrder],
	);

	const {
		isOpen: pickerOpen,
		items: pickerItems,
		selectedIndex: pickerIndex,
		navigate: pickerNavigate,
		close: pickerClose,
	} = useSlashPicker(prompt, allSkills, activeSkill);
	const isConnected = wsStatus === "connected";
	const isRunning = isConnected && sessionState === "running";
	const canRun = (!!activeSkill || prompt.trim().length > 0) && isConnected;
	const handleRun = useCockpitRun({
		prompt,
		activeSkill,
		allSkills,
		wsStatus,
		sameSession,
		attachSessionIdRef,
		pendingAttachments,
		clearPendingAttachments,
		isRunning,
		selectedAgentPath,
		background,
		model,
		send,
		setRunError,
		setPrompt,
		setActiveSkill,
		setRecentRuns,
		setThirtyDayStats,
		setWeeklyStats,
		navigateToRaven: (sessionId, agent) => {
			navigate({ to: "/raven", search: { session: sessionId, agent } });
		},
	});

	const voice = useVoiceInput({
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

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

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

	const modelShort = model ? fmtModel(model) : null;

	return (
		<div className="flex flex-col md:h-full">
			<CockpitHeader config={config} modelShort={modelShort} />

			{/* Usage windows */}
			<ProviderUsageStrip
				initial={initialProviderUsages}
				liveQueryCount={liveStats?.queries ?? 0}
				rateLimit={rateLimit}
				fetchFn={loadProviderUsages}
				tail={<RoutinesWindowSection />}
			/>

			{/* Mobile context band, shows context % when active */}
			<MobileContextBand stats={liveStats} />

			{/* 30-day activity graph */}
			<PrivacyMask>
				<ThirtyDayGraph data={thirtyDayStats} />
			</PrivacyMask>

			{/* Stats, desktop: right sidebar; mobile: collapsible section */}
			<MobileStatsPanel stats={liveStats} agg={agg} isConnected={isConnected} />

			{/* MCP panel */}
			<McpPanel servers={mcpServers} />

			{/* Mobile: collapsible recent runs + this week graph */}
			<MobileRunsPanel
				runs={recentRuns}
				weeklyStats={weeklyStats}
				onRunClick={(id) =>
					navigate({ to: "/raven", search: { session: id, agent: undefined } })
				}
			/>

			{/* Two-column body */}
			<div className="flex md:flex-1 md:overflow-hidden">
				{/* Main column */}
				<div className="flex flex-col flex-1 md:overflow-auto">
					<CockpitPrompt
						config={config}
						prompt={prompt}
						setPrompt={setPrompt}
						activeSkill={activeSkill}
						isConnected={isConnected}
						isRunning={isRunning}
						canRun={canRun}
						selectedAgentPath={selectedAgentPath}
						setSelectedAgentPath={setSelectedAgentPath}
						agentList={agentList}
						background={background}
						setBackground={setBackground}
						sameSession={sameSession}
						setSameSession={setSameSession}
						textareaRef={textareaRef}
						fileInputRef={fileInputRef}
						upload={{
							pendingAttachments,
							uploadingCount,
							uploadError,
							uploadFiles,
							removePending,
						}}
						voice={voice}
						picker={{
							open: pickerOpen,
							items: pickerItems,
							index: pickerIndex,
							navigate: pickerNavigate,
							close: pickerClose,
						}}
						onSkillSelect={handleSkillSelect}
						onClear={handleClear}
						onRun={() => void handleRun()}
					/>

					<CockpitRunError error={runError} />
					<CockpitSkills
						hasSkills={data.skills.length > 0}
						groups={skillGroups}
						activeSkill={activeSkill}
						onSelect={handleSkillSelect}
					/>
				</div>

				{/* Recent runs sidebar, desktop only */}
				<RecentRunsSidebar
					runs={recentRuns}
					weeklyStats={weeklyStats}
					onRunClick={(id) =>
						navigate({
							to: "/raven",
							search: { session: id, agent: undefined },
						})
					}
					stats={liveStats}
					agg={agg}
					activeSession={liveActiveSession}
					className="hidden md:flex"
				/>
			</div>
		</div>
	);
}
