import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useDraft } from "#/hooks/useDraft";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useVoiceInput } from "#/hooks/useVoiceInput";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import {
	addCommandSelection,
	type CommandDescriptor,
	filterProviderCompatibleCommands,
	skillCommand,
} from "#/lib/commands";
import { insertAtSelection, resizeComposer } from "#/lib/composer";
import { fmtModel } from "#/lib/formatters";
import { optionalLoaderValue } from "#/lib/loaderFallback";
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
import { builtInProviderUsageShells } from "#/lib/usageWindows";

// ─── route ───────────────────────────────────────────────────────────────────

const WATCH_OPTIONAL_LOADER_WAIT_MS = 500;
const WATCH_OPTIONAL_RECOVERY_WAIT_MS = 8_000;
const EMPTY_COCKPIT_DATA: Awaited<ReturnType<typeof getCockpitData>> = {
	inboxCount: 0,
	activeCount: 0,
	totalCount: 0,
	skills: [],
	sectionOrder: [],
};
const EMPTY_STATS_DATA: Awaited<ReturnType<typeof getCockpitStatsFn>> = {
	agg: {
		allTime: {
			cost: 0,
			estimated_cost: 0,
			unpriced_queries: 0,
			queries: 0,
			sessions: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
			turns: 0,
		},
		today: {
			cost: 0,
			estimated_cost: 0,
			unpriced_queries: 0,
			queries: 0,
			turns: 0,
			tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
		thisMonth: {
			cost: 0,
			estimated_cost: 0,
			unpriced_queries: 0,
			queries: 0,
			turns: 0,
			tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		},
	},
};
const EMPTY_WEEKLY_STATS: Awaited<ReturnType<typeof getWeeklyStatsFn>> = {
	total: 0,
	days: [0, 0, 0, 0, 0, 0, 0],
};
const EMPTY_THIRTY_DAY_STATS: Awaited<ReturnType<typeof getThirtyDayStatsFn>> =
	{ days: [], total: 0 };
const UNAVAILABLE_VOICE_INFO: Awaited<ReturnType<typeof getVoiceInfoFn>> = {
	status: {
		state: "unavailable",
		model: "",
		error: "voice service unavailable",
	},
	models: [],
};

type CockpitOptionalData = {
	data: Awaited<ReturnType<typeof getCockpitData>>;
	recentSessions: Awaited<ReturnType<typeof getRecentSessionsFn>>;
	statsData: Awaited<ReturnType<typeof getCockpitStatsFn>>;
	mcpServers: Awaited<ReturnType<typeof getMcpServersFn>>;
	weeklyStats: Awaited<ReturnType<typeof getWeeklyStatsFn>>;
	thirtyDayStats: Awaited<ReturnType<typeof getThirtyDayStatsFn>>;
	agentList: Awaited<ReturnType<typeof getAgentListFn>>;
	activeSession: Awaited<ReturnType<typeof getActiveSessionRowFn>>;
	voiceInfo: Awaited<ReturnType<typeof getVoiceInfoFn>>;
};

let cachedCockpitOptionalData: CockpitOptionalData | null = null;

export function restoreCachedCockpitOptionalData(
	incoming: CockpitOptionalData,
): CockpitOptionalData {
	return typeof window === "undefined"
		? incoming
		: (cachedCockpitOptionalData ?? incoming);
}

export function cacheCockpitOptionalData(
	data: CockpitOptionalData,
): CockpitOptionalData {
	if (typeof window !== "undefined") cachedCockpitOptionalData = data;
	return data;
}

/** @internal */
export function clearCockpitOptionalDataCacheForTesting(): void {
	cachedCockpitOptionalData = null;
}

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
			optionalLoaderValue(
				getCockpitData(),
				EMPTY_COCKPIT_DATA,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getRecentSessionsFn(),
				[],
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getCockpitStatsFn(),
				EMPTY_STATS_DATA,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(getMcpServersFn(), [], WATCH_OPTIONAL_LOADER_WAIT_MS),
			optionalLoaderValue(
				getWeeklyStatsFn(),
				EMPTY_WEEKLY_STATS,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getThirtyDayStatsFn(),
				EMPTY_THIRTY_DAY_STATS,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(getAgentListFn(), [], WATCH_OPTIONAL_LOADER_WAIT_MS),
			optionalLoaderValue(
				getActiveSessionRowFn(),
				null,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
			optionalLoaderValue(
				getVoiceInfoFn(),
				UNAVAILABLE_VOICE_INFO,
				WATCH_OPTIONAL_LOADER_WAIT_MS,
			),
		]);
		const optionalDataStatus = [
			data,
			recentSessions,
			statsData,
			mcpServers,
			weeklyStats,
			thirtyDayStats,
			agentList,
			activeSession,
			voiceInfo,
		].some((item) => item.status === "unavailable")
			? ("unavailable" as const)
			: ("ready" as const);
		return {
			config,
			data: data.value,
			recentSessions: recentSessions.value,
			statsData: statsData.value,
			mcpServers: mcpServers.value,
			weeklyStats: weeklyStats.value,
			// Provider discovery is optional dashboard decoration and can involve a
			// busy host CLI. Let the mounted usage strip hydrate it in the background
			// so navigating to Watch never waits on /providers.
			providerUsages: builtInProviderUsageShells(),
			thirtyDayStats: thirtyDayStats.value,
			agentList: agentList.value,
			activeSession: activeSession.value,
			voiceInfo: voiceInfo.value,
			optionalDataStatus,
		};
	},
	component: CockpitPage,
});

/** Composer-local state: prompt text, active skill, run toggles, focus plumbing. */
function useCockpitComposer(initialPlanHtml: boolean) {
	const { input: prompt, setInput: setPrompt } = useDraft({
		existingSessionId: "watch",
		seededPrompt: undefined,
	});
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
				initialStale
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
		composer.setActiveSkills((selected) =>
			filterProviderCompatibleCommands(selected, commandProviderId),
		);
	}, [commandProviderId, composer.setActiveSkills]);
	const picker = useSlashPicker(
		composer.prompt,
		commands,
		composer.activeSkills,
		commandProviderId,
		config.ui.show_provider_entries,
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

function OptionalDataNotice({
	status,
	onRetry,
}: {
	status: "loading" | "ready" | "unavailable";
	onRetry: () => void;
}) {
	if (status === "ready") return null;
	return (
		<output className="mx-4 mt-3 flex items-center justify-between gap-3 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] tracking-wider text-[var(--status-warning)] uppercase">
			<span>
				{status === "loading"
					? "Restoring dashboard data…"
					: "Some dashboard data is unavailable"}
			</span>
			{status === "unavailable" && (
				<button
					type="button"
					onClick={onRetry}
					className="shrink-0 border border-amber-500/40 px-2 py-1 hover:bg-amber-500/10"
				>
					Retry
				</button>
			)}
		</output>
	);
}

export function preserveCockpitDataDuringFallback<T>(
	current: T,
	incoming: T,
	status: "ready" | "unavailable",
): T {
	return status === "ready" ? incoming : current;
}

function CockpitPage() {
	const loader = Route.useLoaderData();
	const { config } = loader;
	const [optionalData, setOptionalData] = useState(() =>
		restoreCachedCockpitOptionalData({
			data: loader.data,
			recentSessions: loader.recentSessions,
			statsData: loader.statsData,
			mcpServers: loader.mcpServers,
			weeklyStats: loader.weeklyStats,
			thirtyDayStats: loader.thirtyDayStats,
			agentList: loader.agentList,
			activeSession: loader.activeSession,
			voiceInfo: loader.voiceInfo,
		}),
	);
	const [optionalDataStatus, setOptionalDataStatus] = useState<
		"loading" | "ready" | "unavailable"
	>(loader.optionalDataStatus);
	useEffect(() => {
		const incoming = {
			data: loader.data,
			recentSessions: loader.recentSessions,
			statsData: loader.statsData,
			mcpServers: loader.mcpServers,
			weeklyStats: loader.weeklyStats,
			thirtyDayStats: loader.thirtyDayStats,
			agentList: loader.agentList,
			activeSession: loader.activeSession,
			voiceInfo: loader.voiceInfo,
		};
		setOptionalData((current) =>
			cacheCockpitOptionalData(
				preserveCockpitDataDuringFallback(
					current,
					incoming,
					loader.optionalDataStatus,
				),
			),
		);
		setOptionalDataStatus(loader.optionalDataStatus);
	}, [
		loader.data,
		loader.recentSessions,
		loader.statsData,
		loader.mcpServers,
		loader.weeklyStats,
		loader.thirtyDayStats,
		loader.agentList,
		loader.activeSession,
		loader.voiceInfo,
		loader.optionalDataStatus,
	]);
	const refreshOptionalData = useCallback(async () => {
		setOptionalDataStatus("loading");
		const results = await Promise.all([
			optionalLoaderValue(
				getCockpitData(),
				EMPTY_COCKPIT_DATA,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getRecentSessionsFn(),
				[],
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getCockpitStatsFn(),
				EMPTY_STATS_DATA,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getMcpServersFn(),
				[],
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getWeeklyStatsFn(),
				EMPTY_WEEKLY_STATS,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getThirtyDayStatsFn(),
				EMPTY_THIRTY_DAY_STATS,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getAgentListFn(),
				[],
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getActiveSessionRowFn(),
				null,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
			optionalLoaderValue(
				getVoiceInfoFn(),
				UNAVAILABLE_VOICE_INFO,
				WATCH_OPTIONAL_RECOVERY_WAIT_MS,
			),
		]);
		setOptionalData((current) =>
			cacheCockpitOptionalData({
				data: results[0].status === "ready" ? results[0].value : current.data,
				recentSessions:
					results[1].status === "ready"
						? results[1].value
						: current.recentSessions,
				statsData:
					results[2].status === "ready" ? results[2].value : current.statsData,
				mcpServers:
					results[3].status === "ready" ? results[3].value : current.mcpServers,
				weeklyStats:
					results[4].status === "ready"
						? results[4].value
						: current.weeklyStats,
				thirtyDayStats:
					results[5].status === "ready"
						? results[5].value
						: current.thirtyDayStats,
				agentList:
					results[6].status === "ready" ? results[6].value : current.agentList,
				activeSession:
					results[7].status === "ready"
						? results[7].value
						: current.activeSession,
				voiceInfo:
					results[8].status === "ready" ? results[8].value : current.voiceInfo,
			}),
		);
		setOptionalDataStatus(
			results.every((result) => result.status === "ready")
				? "ready"
				: "unavailable",
		);
	}, []);
	useEffect(() => {
		if (loader.optionalDataStatus === "unavailable") void refreshOptionalData();
	}, [loader.optionalDataStatus, refreshOptionalData]);
	const { data, agentList } = optionalData;
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useWsLiveStats();
	const composer = useCockpitComposer(config.ui.html_plans ?? false);
	const live = useCockpitLiveData(
		{
			recentSessions: optionalData.recentSessions,
			agg: optionalData.statsData.agg,
			weeklyStats: optionalData.weeklyStats,
			thirtyDayStats: optionalData.thirtyDayStats,
			activeSession: optionalData.activeSession,
			mcpServers: optionalData.mcpServers,
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
	const voice = useCockpitVoice(
		config,
		optionalData.voiceInfo,
		composer,
		handleRun,
	);

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
					<OptionalDataNotice
						status={optionalDataStatus}
						onRetry={() => void refreshOptionalData()}
					/>
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
