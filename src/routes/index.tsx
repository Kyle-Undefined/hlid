import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { Paperclip } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentSelect } from "#/components/AgentSelect";
import { AttachmentStrip } from "#/components/AttachmentStrip";
import {
	MobileRunsPanel,
	RecentRunsSidebar,
} from "#/components/cockpit/CockpitSidebar";
import {
	McpPanel,
	type McpServerEntry,
	mapMcpServer,
} from "#/components/cockpit/McpPanel";
import { MobileContextBand } from "#/components/cockpit/MobileContextBand";
import { MobileStatsPanel } from "#/components/cockpit/MobileStatsPanel";
import { SkillCard } from "#/components/cockpit/SkillCard";
import { SlashPicker } from "#/components/cockpit/SlashPicker";
import { ThirtyDayGraph } from "#/components/cockpit/ThirtyDayGraph";
import { PrivacyMask } from "#/components/PrivacyMask";
import {
	ProviderUsageStrip,
	RoutinesWindowSection,
} from "#/components/UsageWindowsPanel";
import { FirstRunWizard } from "#/components/wizard/FirstRunWizard";
import { getConfig } from "#/config";
import type { AggStats, SessionRow, ThirtyDayStats, WeeklyStats } from "#/db";
import { useFileUpload } from "#/hooks/useFileUpload";
import { useMergedSkills } from "#/hooks/useMergedSkills";
import { useSlashPicker } from "#/hooks/useSlashPicker";
import { useWs } from "#/hooks/useWs";
import { useWsLiveStats } from "#/hooks/useWsSelectors";
import * as wsStore from "#/hooks/wsStore";
import { fmtModel } from "#/lib/formatters";
import {
	getActiveSessionRowFn,
	getAgentListFn,
	getCockpitData,
	getCockpitStatsFn,
	getCurrentSessionFn,
	getMcpServersFn,
	getProvidersFn,
	getProviderUsagesFn,
	getRecentSessionsFn,
	getThirtyDayStatsFn,
	getWeeklyStatsFn,
} from "#/lib/serverFns";
import { resolveSessionId } from "#/lib/sessionRouting";
import { resolveSkillPrompt } from "#/lib/skillPrompt";
import { groupSkills, type Skill } from "#/lib/skills";
import { SESSION_LABEL_LENGTH, uid } from "#/lib/utils";
import type { RateLimitMessage, ServerMessage } from "#/server/protocol";

// ─── route ───────────────────────────────────────────────────────────────────

async function loadProviderUsages() {
	const providers = await getProvidersFn();
	const providerIds = providers.map((provider) => provider.id);
	return getProviderUsagesFn({
		data: providerIds.length > 0 ? providerIds : ["claude"],
	});
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
			providerUsages,
			thirtyDayStats,
			agentList,
			activeSession,
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
	} = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useWsLiveStats();
	const [prompt, setPrompt] = useState("");
	const [selectedAgentPath, setSelectedAgentPath] = useState("");
	const [activeSkill, setActiveSkill] = useState<{
		name: string;
		section?: string;
		filePath: string;
	} | null>(null);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
	const [recentRuns, setRecentRuns] = useState<SessionRow[]>(recentSessions);
	const [agg, setAgg] = useState<AggStats>(statsData.agg);
	const [weeklyStats, setWeeklyStats] = useState<WeeklyStats>(() => {
		if (!wsStore.getPendingSessionToday()) return initialWeeklyStats;
		const dow = new Date().getDay();
		const days = [...initialWeeklyStats.days];
		days[dow] = (days[dow] ?? 0) + 1;
		return { total: initialWeeklyStats.total + 1, days };
	});
	const [thirtyDayStats, setThirtyDayStats] = useState<ThirtyDayStats>(() => {
		if (!wsStore.getPendingSessionToday()) return initialThirtyDayStats;
		const today = new Date().toISOString().slice(0, 10);
		const hasToday = initialThirtyDayStats.days.some((d) => d.date === today);
		return {
			total: initialThirtyDayStats.total + 1,
			days: hasToday
				? initialThirtyDayStats.days.map((d) =>
						d.date === today ? { ...d, count: d.count + 1 } : d,
					)
				: [...initialThirtyDayStats.days, { date: today, count: 1 }],
		};
	});
	const [liveActiveSession, setLiveActiveSession] = useState<SessionRow | null>(
		activeSession,
	);
	const [mcpServers, setMcpServers] =
		useState<McpServerEntry[]>(initialMcpServers);
	const [sdkSlashCommands, setSdkSlashCommands] = useState<
		Array<{
			name: string;
			description: string;
			argumentHint: string;
			aliases?: string[];
		}>
	>([]);
	const [runError, setRunError] = useState<string | null>(null);
	const [rateLimit, setRateLimit] = useState<RateLimitMessage | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const { wsStatus, sessionState, model, send } = useWs(
		(msg: ServerMessage) => {
			if (msg.type === "done") {
				setRunError(null);
				getRecentSessionsFn().then(setRecentRuns);
				getCockpitStatsFn().then((d) => setAgg(d.agg));
				getWeeklyStatsFn().then(setWeeklyStats);
				getThirtyDayStatsFn().then(setThirtyDayStats);
				getActiveSessionRowFn().then(setLiveActiveSession);
			}
			if (msg.type === "error") {
				setRunError(msg.message);
			}
			if (msg.type === "rate_limit") {
				setRateLimit(msg);
			}
			if (msg.type === "mcp_status") {
				setMcpServers(msg.servers.map(mapMcpServer));
			}
			if (msg.type === "slash_commands") {
				setSdkSlashCommands(msg.commands);
			}
		},
	);

	useEffect(() => {
		send({ type: "sync_mcp_list" });
		send({ type: "probe_slash_commands" });
	}, [send]);

	// Refresh active session on mount — router cache may serve stale loader data
	// when user navigates back to / after a session completed elsewhere.
	useEffect(() => {
		let active = true;
		void getActiveSessionRowFn().then((s) => {
			if (active) setLiveActiveSession(s);
		});
		return () => {
			active = false;
		};
	}, []);

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

	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt length triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
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

	async function handleRun() {
		const typed = prompt.trim();
		const { text, skillContext } = resolveSkillPrompt(
			activeSkill,
			typed,
			allSkills,
		);
		if (!text || wsStatus !== "connected") return;
		setRunError(null);
		// Resolve session: same-session → prefer active, then most recent from DB,
		// then new; unchecked → always new (attachment pre-selection takes priority)
		const currentId = sameSession ? await getCurrentSessionFn() : null;
		const mostRecentId =
			sameSession && !currentId
				? (await getRecentSessionsFn())[0]?.id
				: undefined;
		const sessionId = resolveSessionId({
			sameSession,
			currentId,
			mostRecentId,
			attachedId: attachSessionIdRef.current,
			newId: uid(),
		});
		attachSessionIdRef.current = null;
		const attachments = pendingAttachments;
		clearPendingAttachments();

		if (isRunning) {
			wsStore.enqueueChat({
				id: uid(),
				text,
				session_id: sessionId,
				skill_context: skillContext,
				agent_cwd: selectedAgentPath || undefined,
				attachments: attachments.length > 0 ? attachments : undefined,
			});
			setPrompt("");
			setActiveSkill(null);
			if (!background) {
				navigate({
					to: "/raven",
					search: {
						session: sessionId,
						agent: selectedAgentPath || undefined,
					},
				});
			}
			return;
		}

		if (!sameSession) wsStore.resetLiveStats();
		wsStore.setActiveSessionId(sessionId);
		send({
			type: "chat",
			text,
			session_id: sessionId,
			skill_context: skillContext,
			agent_cwd: selectedAgentPath || undefined,
			attachments: attachments.length > 0 ? attachments : undefined,
		});
		if (!sameSession) {
			setRecentRuns((prev) => {
				const already = prev.some((r) => r.id === sessionId);
				if (already) return prev;
				const pending: SessionRow = {
					id: sessionId,
					label: text.slice(0, SESSION_LABEL_LENGTH).toUpperCase(),
					model: model ?? null,
					started_at: Math.floor(Date.now() / 1000),
					ended_at: null,
					query_count: 0,
					total_cost: 0,
					total_input_tokens: 0,
					total_output_tokens: 0,
					total_cache_read_tokens: 0,
					total_cache_creation_tokens: 0,
					total_turns: 0,
				};
				return [pending, ...prev].slice(0, 5);
			});
			const today = new Date().toISOString().slice(0, 10);
			setThirtyDayStats((prev) => {
				const hasToday = prev.days.some((d) => d.date === today);
				return {
					total: prev.total + 1,
					days: hasToday
						? prev.days.map((d) =>
								d.date === today ? { ...d, count: d.count + 1 } : d,
							)
						: [...prev.days, { date: today, count: 1 }],
				};
			});
			setWeeklyStats((prev) => {
				const dow = new Date().getDay();
				const days = [...prev.days];
				days[dow] = (days[dow] ?? 0) + 1;
				return { total: prev.total + 1, days };
			});
		}
		setPrompt("");
		setActiveSkill(null);
		if (!background) {
			wsStore.setPendingPrompt(text);
			navigate({
				to: "/raven",
				search: {
					session: sessionId,
					agent: selectedAgentPath || undefined,
				},
			});
		}
	}

	const isConnected = wsStatus === "connected";
	const isRunning = isConnected && sessionState === "running";
	const canRun = (!!activeSkill || prompt.trim().length > 0) && isConnected;

	const modelShort = model ? fmtModel(model) : null;

	return (
		<div className="flex flex-col md:h-full">
			{/* Header strip */}
			<div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
				<PrivacyMask
					inline
					className="text-[11px] tracking-widest text-primary uppercase"
				>
					{config.vault.name || "HLID"}
				</PrivacyMask>
				{modelShort && (
					<>
						<span className="text-muted-foreground/25">·</span>
						<span className="text-[10px] tracking-widest text-muted-foreground/40">
							{modelShort}
						</span>
					</>
				)}
			</div>

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
					{/* Prompt area */}
					<div className="p-4 border-b border-border space-y-2 shrink-0">
						<div className="flex items-center justify-between mb-1">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								PROMPT
								{activeSkill && (
									<span className="text-primary/50 ml-2">
										· {activeSkill.name}
									</span>
								)}
							</div>
						</div>

						<section
							aria-label="Prompt input area"
							className={`relative border bg-card transition-colors ${isConnected ? "border-border focus-within:border-primary/30" : "border-border/40"}`}
							onDragOver={(e) => {
								if (e.dataTransfer?.types?.includes("Files"))
									e.preventDefault();
							}}
							onDrop={(e) => {
								if (e.dataTransfer?.files?.length) {
									e.preventDefault();
									void uploadFiles(e.dataTransfer.files);
								}
							}}
						>
							{pickerOpen && (
								<SlashPicker
									items={pickerItems}
									selectedIndex={pickerIndex}
									onSelect={handleSkillSelect}
								/>
							)}
							<AttachmentStrip
								attachments={pendingAttachments}
								uploadingCount={uploadingCount}
								uploadError={uploadError}
								onRemove={removePending}
								className="px-3 py-2"
							/>
							<div className="flex items-start">
								<span className="text-primary text-sm px-3 py-2.5 shrink-0 select-none">
									›
								</span>
								<textarea
									ref={textareaRef}
									value={prompt}
									onChange={(e) => {
										setPrompt(e.target.value);
									}}
									onKeyDown={(e) => {
										// Slash picker navigation — intercept before run handlers
										if (pickerOpen) {
											if (e.key === "ArrowDown") {
												e.preventDefault();
												pickerNavigate(1);
												return;
											}
											if (e.key === "ArrowUp") {
												e.preventDefault();
												pickerNavigate(-1);
												return;
											}
											if (e.key === "Escape") {
												e.preventDefault();
												pickerClose();
												return;
											}
											if (e.key === "Tab") {
												e.preventDefault();
												if (pickerItems.length > 0)
													handleSkillSelect(pickerItems[pickerIndex]);
												return;
											}
											if (
												e.key === "Enter" &&
												!e.shiftKey &&
												!e.metaKey &&
												!e.ctrlKey
											) {
												e.preventDefault();
												if (pickerItems.length > 0)
													handleSkillSelect(pickerItems[pickerIndex]);
												return;
											}
										}
										if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
											e.preventDefault();
											handleRun();
											return;
										}
										const isTouch =
											typeof window !== "undefined" &&
											window.matchMedia("(pointer: coarse)").matches;
										if (
											e.key === "Enter" &&
											!e.shiftKey &&
											!isTouch &&
											config.ui.enter_to_submit
										) {
											e.preventDefault();
											handleRun();
										}
									}}
									role="combobox"
									aria-expanded={pickerOpen}
									aria-controls="slash-picker"
									aria-autocomplete="list"
									aria-activedescendant={
										pickerOpen ? `slash-picker-opt-${pickerIndex}` : undefined
									}
									rows={3}
									placeholder={
										!isConnected
											? "server offline…"
											: activeSkill
												? "add context… (optional)"
												: "type a prompt, or pick a skill below"
									}
									disabled={!isConnected}
									className={`flex-1 resize-none bg-transparent py-2.5 pr-3 text-sm text-foreground focus:outline-none disabled:opacity-30 overflow-hidden min-h-[72px] ${!isConnected ? "placeholder:text-foreground/50" : "placeholder:text-muted-foreground/25"}`}
								/>
							</div>
							{agentList.length > 0 && (
								<div className="md:hidden flex items-baseline gap-2 px-3 py-1.5 border-t border-border/60">
									<AgentSelect
										agents={agentList}
										value={selectedAgentPath}
										onChange={setSelectedAgentPath}
										fullWidth
									/>
								</div>
							)}
							<div className="flex items-center justify-between px-3 py-2 border-t border-border/60">
								<div className="flex items-center gap-3">
									<input
										ref={fileInputRef}
										type="file"
										multiple
										className="hidden"
										onChange={(e) => {
											if (e.target.files) void uploadFiles(e.target.files);
											e.target.value = "";
										}}
									/>
									<button
										type="button"
										onClick={() => fileInputRef.current?.click()}
										disabled={!isConnected}
										className="text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0 disabled:opacity-30"
										aria-label="Attach file"
										title="Attach file"
									>
										<Paperclip className="w-3.5 h-3.5" />
									</button>
									{agentList.length > 0 && (
										<div className="hidden md:flex items-baseline gap-1.5">
											<AgentSelect
												agents={agentList}
												value={selectedAgentPath}
												onChange={setSelectedAgentPath}
											/>
										</div>
									)}
									<label className="flex items-center gap-1.5 cursor-pointer select-none group">
										<input
											type="checkbox"
											checked={background}
											onChange={(e) => setBackground(e.target.checked)}
											className="sr-only"
										/>
										<span
											className={`w-3 h-3 border flex items-center justify-center shrink-0 transition-colors ${background ? "border-primary bg-primary/20" : "border-border bg-secondary group-hover:border-primary/40"}`}
										>
											{background && (
												<span className="w-1.5 h-1.5 bg-primary block" />
											)}
										</span>
										<span className="text-[9px] tracking-wider text-muted-foreground/40 uppercase">
											Background
										</span>
									</label>
									<label className="flex items-center gap-1.5 cursor-pointer select-none group">
										<input
											type="checkbox"
											checked={sameSession}
											onChange={(e) => setSameSession(e.target.checked)}
											className="sr-only"
										/>
										<span
											className={`w-3 h-3 border flex items-center justify-center shrink-0 transition-colors ${sameSession ? "border-primary bg-primary/20" : "border-border bg-secondary group-hover:border-primary/40"}`}
										>
											{sameSession && (
												<span className="w-1.5 h-1.5 bg-primary block" />
											)}
										</span>
										<span className="text-[9px] tracking-wider text-muted-foreground/40 uppercase">
											Same Session
										</span>
									</label>
								</div>
								<div className="flex gap-2">
									{(prompt || activeSkill) && (
										<button
											type="button"
											onClick={handleClear}
											className="px-3 py-1 border border-border text-[10px] tracking-widest text-muted-foreground/50 hover:text-foreground hover:border-border/80 transition-colors uppercase"
										>
											CLEAR
										</button>
									)}
									<button
										type="button"
										onClick={handleRun}
										disabled={!canRun}
										className="px-3 py-1 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-25 uppercase"
									>
										{isRunning ? "QUEUE →" : "RUN →"}
									</button>
								</div>
							</div>
						</section>
					</div>

					{/* Background run error */}
					{runError && (
						<div className="px-4 py-2 border-b border-destructive/20 bg-destructive/5 shrink-0">
							<span className="text-[10px] tracking-wider text-destructive/80">
								ERR: {runError}
							</span>
						</div>
					)}

					{/* Skills */}
					{data.skills.length > 0 ? (
						<div className="p-4 grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
							{skillGroups.map((g) => (
								<div
									key={g.section ?? "__unsectioned__"}
									className="space-y-2 min-w-0"
								>
									<div className="flex items-center gap-2">
										<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
										<PrivacyMask
											inline
											className="text-[10px] tracking-widest text-muted-foreground uppercase"
										>
											{g.section ?? "SKILLS"}
										</PrivacyMask>
										<span className="text-[10px] text-muted-foreground/50">
											{g.skills.length}
										</span>
									</div>
									<div className="grid grid-cols-2 gap-2 md:grid-cols-1">
										{g.skills.map((skill) => (
											<SkillCard
												key={skill.file}
												skill={skill}
												active={activeSkill?.name === skill.name}
												onSelect={(s) => handleSkillSelect(s)}
											/>
										))}
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="flex-1 flex items-center justify-center">
							<div className="text-center space-y-2">
								<div className="text-[10px] tracking-widest text-muted-foreground/30 uppercase">
									no skills yet
								</div>
								<div className="text-[9px] tracking-wider text-muted-foreground/20">
									drop .md files into your vault skills folder
								</div>
							</div>
						</div>
					)}
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
