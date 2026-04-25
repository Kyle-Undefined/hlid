import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StatusDot } from "#/components/nav/StatusDot";
import { FirstRunWizard } from "#/components/wizard/FirstRunWizard";
import { getConfig } from "#/config";
import type { SessionRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import type { Skill } from "#/lib/vault";
import type { ServerMessage } from "#/server/protocol";

// ─── server fns ──────────────────────────────────────────────────────────────

const getCockpitData = createServerFn({ method: "GET" }).handler(async () => {
	const [{ readdirSync }, { join }, { scanProjects, scanSkills }] =
		await Promise.all([
			import("node:fs"),
			import("node:path"),
			import("#/lib/vault"),
		]);
	const config = await getConfig();
	const { vault, status_vocabulary } = config;

	let inboxCount = 0;
	if (vault.path && vault.inbox) {
		try {
			inboxCount = readdirSync(join(vault.path, vault.inbox)).filter((f) =>
				f.endsWith(".md"),
			).length;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("Failed to read inbox directory:", err);
			}
		}
	}

	let activeCount = 0;
	let totalCount = 0;
	if (vault.path && vault.projects) {
		const projects = scanProjects(
			vault.path,
			vault.projects,
			status_vocabulary,
		);
		totalCount = projects.length;
		activeCount = projects.filter((p) => p.status === "active").length;
	}

	const { skills, sectionOrder } =
		vault.path && vault.skills
			? scanSkills(vault.path, vault.skills, config.ui.hide_skills_index)
			: { skills: [], sectionOrder: [] };

	return { inboxCount, activeCount, totalCount, skills, sectionOrder };
});

const getRecentSessionsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		const res = await fetch(
			`http://localhost:${server.port + 1}/db/recent-sessions?limit=14`,
		);
		if (!res.ok) return [] as SessionRow[];
		return res.json() as Promise<SessionRow[]>;
	},
);

const getCurrentSessionIdFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { server } = await getConfig();
		try {
			const res = await fetch(
				`http://localhost:${server.port + 1}/db/current-session`,
			);
			if (!res.ok) return null as string | null;
			const data = (await res.json()) as { session_id: string | null };
			return data.session_id;
		} catch {
			return null as string | null;
		}
	},
);

// ─── route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/")({
	loader: async () => {
		const [config, data, recentSessions] = await Promise.all([
			getConfig(),
			getCockpitData(),
			getRecentSessionsFn(),
		]);
		return { config, data, recentSessions };
	},
	component: CockpitPage,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtRunTime(unixSecs: number): string {
	const d = new Date(unixSecs * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── components ──────────────────────────────────────────────────────────────

function StatCell({
	label,
	value,
	dim,
}: {
	label: string;
	value: string;
	dim?: boolean;
}) {
	return (
		<div className="px-4 py-3 flex flex-col gap-1">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<div
				className={`text-xl font-bold tabular-nums ${dim ? "text-muted-foreground/20" : "text-[#38bdf8]"}`}
			>
				{value}
			</div>
		</div>
	);
}

function groupSkills(
	skills: Skill[],
	sectionOrder: string[],
): { section: string | null; skills: Skill[] }[] {
	const groups: { section: string | null; skills: Skill[] }[] = [];
	const seen = new Set<string>();
	for (const sec of sectionOrder) {
		const members = skills.filter((s) => s.section === sec);
		if (members.length === 0) continue;
		groups.push({ section: sec, skills: members });
		for (const s of members) seen.add(s.file);
	}
	const unsectioned = skills.filter((s) => !seen.has(s.file));
	if (unsectioned.length > 0)
		groups.push({ section: null, skills: unsectioned });
	return groups;
}

function SkillRow({
	skill,
	active,
	onSelect,
}: {
	skill: Skill;
	active: boolean;
	onSelect: (content: string, name: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(`/${skill.name} `, skill.name)}
			className={`flex items-center w-full px-4 py-2.5 gap-4 border-l-2 text-left transition-colors group ${
				active
					? "border-primary bg-primary/[0.08]"
					: "border-transparent hover:border-primary/30 hover:bg-primary/[0.03]"
			}`}
		>
			<ChevronRight
				className={`w-3 h-3 shrink-0 transition-transform ${
					active
						? "rotate-90 text-primary"
						: "text-muted-foreground/25 group-hover:text-primary/40"
				}`}
			/>
			<span
				className={`text-[11px] tracking-wider font-medium uppercase w-36 shrink-0 truncate ${
					active ? "text-primary" : "text-foreground/80"
				}`}
			>
				{skill.name}
			</span>
			{skill.description && (
				<span className="text-[10px] text-muted-foreground/50 truncate flex-1 leading-snug">
					{skill.description}
				</span>
			)}
		</button>
	);
}

function RecentRunsStrip({
	runs,
	onRunClick,
}: {
	runs: SessionRow[];
	onRunClick: (sessionId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	if (runs.length === 0) return null;
	const latest = runs[0];
	const rest = runs.slice(1);

	return (
		<div className="border-b border-border shrink-0">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-3 w-full px-4 py-2 hover:bg-accent/50 transition-colors text-left group"
			>
				<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
					LAST RUN
				</span>
				<span className="text-[10px] tabular-nums text-[#38bdf8]/50 shrink-0 font-mono">
					{fmtRunTime(latest.started_at)}
				</span>
				<span className="text-[10px] tracking-wider text-muted-foreground/60 truncate flex-1">
					{latest.label ?? "—"}
				</span>
				{rest.length > 0 && (
					<span
						className={`text-[9px] tracking-widest text-muted-foreground/30 shrink-0 transition-transform group-hover:text-muted-foreground/50 ${open ? "rotate-180" : ""}`}
					>
						{open ? "▲" : `▼ ${rest.length} MORE`}
					</span>
				)}
			</button>
			{open && rest.length > 0 && (
				<div className="border-t border-border/40">
					{rest.map((run) => (
						<button
							key={run.id}
							type="button"
							onClick={() => onRunClick(run.id)}
							className="flex items-baseline gap-3 px-4 py-1.5 border-b border-border/20 last:border-0 w-full text-left hover:bg-accent/30 transition-colors"
						>
							<span className="text-[10px] tabular-nums text-[#38bdf8]/40 shrink-0 w-9 font-mono">
								{fmtRunTime(run.started_at)}
							</span>
							<span className="text-[10px] tracking-wider text-muted-foreground/50 truncate">
								{run.label ?? "—"}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// ─── page ────────────────────────────────────────────────────────────────────

function CockpitPage() {
	const { config, data, recentSessions } = Route.useLoaderData();
	const router = useRouter();
	const navigate = useNavigate();
	const liveStats = useSyncExternalStore(
		wsStore.subscribeStats,
		wsStore.getLiveStats,
		() => ({ cost: 0, queries: 0 }) as wsStore.LiveStats,
	);
	const [prompt, setPrompt] = useState("");
	const [activeSkill, setActiveSkill] = useState<string | null>(null);
	const [background, setBackground] = useState(false);
	const [sameSession, setSameSession] = useState(false);
	const [recentRuns, setRecentRuns] = useState<SessionRow[]>(recentSessions);
	const [runError, setRunError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const { wsStatus, sessionState, model, send } = useWs(
		(msg: ServerMessage) => {
			if (msg.type === "done") {
				setRunError(null);
				getRecentSessionsFn().then(setRecentRuns);
			}
			if (msg.type === "error") {
				setRunError(msg.message);
			}
		},
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt length triggers resize
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
	}, [prompt]);

	if (!config.vault.path) {
		return <FirstRunWizard onComplete={() => router.invalidate()} />;
	}

	function handleSkillSelect(content: string, name: string) {
		setPrompt(content);
		setActiveSkill(name);
		setTimeout(() => textareaRef.current?.focus(), 0);
	}

	function handleClear() {
		setPrompt("");
		setActiveSkill(null);
	}

	async function handleRun() {
		const text = prompt.trim();
		if (!text || isRunning || wsStatus !== "connected") return;
		setRunError(null);
		let sessionId: string;
		if (sameSession) {
			const currentId = await getCurrentSessionIdFn();
			sessionId = currentId ?? uid();
		} else {
			sessionId = uid();
		}
		send({ type: "chat", text, session_id: sessionId });
		setPrompt("");
		setActiveSkill(null);
		if (!background) {
			wsStore.setPendingPrompt(text);
			navigate({ to: "/chat", search: { session: sessionId } });
		}
	}

	const isConnected = wsStatus === "connected";
	const isRunning = isConnected && sessionState === "running";
	const canRun = prompt.trim().length > 0 && !isRunning && isConnected;

	const costStr =
		liveStats.cost > 0
			? `$${liveStats.cost.toFixed(4)}`
			: isConnected
				? "$0.0000"
				: "--";

	const MODEL_LABELS: Record<string, string> = {
		"claude-opus-4-7": "Opus 4.7",
		"claude-sonnet-4-6": "Sonnet 4.6",
		"claude-haiku-4-5-20251001": "Haiku 4.5",
	};
	const modelShort = model
		? (MODEL_LABELS[model] ??
			model.replace("claude-", "").replace(/-\d{8}$/, ""))
		: null;

	return (
		<div className="flex flex-col h-full">
			{/* Header strip */}
			<div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
				<div className="flex items-center gap-3">
					<span className="text-[11px] tracking-widest text-primary uppercase">
						{config.vault.name || "HLID"}
					</span>
					{modelShort && (
						<>
							<span className="text-muted-foreground/25">·</span>
							<span className="text-[10px] tracking-widest text-muted-foreground/40">
								{modelShort}
							</span>
						</>
					)}
				</div>
				<StatusDot />
			</div>

			{/* Stat bar */}
			<div className="border-b border-border shrink-0">
				<div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border">
					<StatCell
						label="INBOX"
						value={config.vault.inbox ? String(data.inboxCount) : "--"}
						dim={!config.vault.inbox}
					/>
					<StatCell
						label="ACTIVE"
						value={config.vault.projects ? String(data.activeCount) : "--"}
						dim={!config.vault.projects}
					/>
					<StatCell
						label="PROJECTS"
						value={config.vault.projects ? String(data.totalCount) : "--"}
						dim={!config.vault.projects}
					/>
					<StatCell label="SESSION COST" value={costStr} dim={!isConnected} />
				</div>
			</div>

			{/* Recent runs strip */}
			<RecentRunsStrip
				runs={recentRuns}
				onRunClick={(id) => navigate({ to: "/chat", search: { session: id } })}
			/>

			{/* Main body — single column */}
			<div className="flex flex-1 flex-col overflow-auto">
				{/* Prompt area */}
				<div className="p-4 border-b border-border space-y-2 shrink-0">
					<div className="flex items-center justify-between mb-1">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							PROMPT
							{activeSkill && (
								<span className="text-primary/50 ml-2">· {activeSkill}</span>
							)}
						</div>
					</div>

					<div
						className={`border bg-card transition-colors ${isConnected ? "border-border focus-within:border-primary/30" : "border-border/40"}`}
					>
						<div className="flex items-start">
							<span className="text-primary text-sm px-3 py-2.5 shrink-0 select-none">
								›
							</span>
							<textarea
								ref={textareaRef}
								value={prompt}
								onChange={(e) => {
									setPrompt(e.target.value);
									if (activeSkill) setActiveSkill(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										handleRun();
									}
								}}
								rows={3}
								placeholder={
									!isConnected
										? "server offline…"
										: "type a prompt, or pick a skill below"
								}
								disabled={!isConnected}
								className="flex-1 resize-none bg-transparent py-2.5 pr-3 text-sm text-foreground placeholder:text-muted-foreground/25 focus:outline-none disabled:opacity-30 overflow-hidden min-h-[72px]"
							/>
						</div>
						<div className="flex items-center justify-between px-3 py-2 border-t border-border/60">
							<div className="flex items-center gap-3">
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
								{prompt && (
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
									RUN →
								</button>
							</div>
						</div>
					</div>
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
					<div className="p-4 space-y-5">
						{groupSkills(data.skills, data.sectionOrder).map((g) => (
							<div key={g.section ?? "__unsectioned__"} className="space-y-2">
								<div className="flex items-center gap-2">
									<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
									<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
										{g.section ?? "SKILLS"}
									</span>
									<span className="text-[10px] text-muted-foreground/50">
										{g.skills.length}
									</span>
								</div>
								<div className="border border-border bg-card divide-y divide-border">
									{g.skills.map((skill) => (
										<SkillRow
											key={skill.file}
											skill={skill}
											active={activeSkill === skill.name}
											onSelect={handleSkillSelect}
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
		</div>
	);
}
