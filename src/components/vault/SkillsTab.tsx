import { ChevronDown, ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { Skill } from "#/lib/vault";

// ─── SkillCard ────────────────────────────────────────────────────────────────

function SkillCard({
	skill,
	onRun,
}: {
	skill: Skill;
	onRun: (content: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="divide-y divide-border">
			<div className="flex items-center gap-3 px-4 py-3">
				<button
					type="button"
					onClick={() => skill.content && setOpen((v) => !v)}
					aria-expanded={open}
					aria-controls={`skill-panel-${skill.file}`}
					className={`flex items-center gap-3 min-w-0 flex-1 text-left transition-opacity ${skill.content ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
				>
					{open ? (
						<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
					) : (
						<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
					)}
					<div className="min-w-0">
						<PrivacyMask className="text-sm text-foreground truncate">
							{skill.name}
						</PrivacyMask>
						{skill.description && (
							<PrivacyMask className="text-xs text-muted-foreground mt-0.5 truncate">
								{skill.description}
							</PrivacyMask>
						)}
					</div>
				</button>
				<button
					type="button"
					onClick={() => {
						const safeName = skill.name.replace(/[^\w-]/g, "");
						if (safeName) onRun(`/${safeName}`);
					}}
					title="Run this skill"
					className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 border border-primary/20 text-[10px] tracking-widest text-primary hover:bg-primary/20 transition-colors shrink-0 uppercase"
				>
					<Play className="w-3 h-3" />
					RUN
				</button>
			</div>
			{open && skill.content && (
				<div
					id={`skill-panel-${skill.file}`}
					className="px-6 py-4 bg-secondary/30 text-xs text-foreground/80 leading-relaxed"
				>
					<PrivacyMask>
						<MarkdownBody content={skill.content} />
					</PrivacyMask>
				</div>
			)}
		</div>
	);
}

// ─── groupSkills ──────────────────────────────────────────────────────────────

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

// ─── SkillsTab ────────────────────────────────────────────────────────────────

export function SkillsTab({
	skills,
	sectionOrder,
	onRun,
}: {
	skills: Skill[];
	sectionOrder: string[];
	onRun: (content: string) => void;
}) {
	if (skills.length === 0) {
		return (
			<div className="border border-border bg-card px-4 py-8 text-center">
				<p className="text-xs tracking-wider text-muted-foreground">
					no skills here yet, add{" "}
					<code className="font-mono text-primary">.md</code> files to your
					skills folder
				</p>
			</div>
		);
	}

	const groups = groupSkills(skills, sectionOrder);

	return (
		<div className="space-y-6">
			{groups.map((g) => (
				<div key={g.section ?? "__unsectioned__"} className="space-y-2">
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
					<div className="border border-border bg-card divide-y divide-border">
						{g.skills.map((s) => (
							<SkillCard key={s.file} skill={s} onRun={onRun} />
						))}
					</div>
				</div>
			))}
		</div>
	);
}
