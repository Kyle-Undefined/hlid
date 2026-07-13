import { Play } from "lucide-react";
import { useMemo, useState } from "react";
import { MarkdownBody } from "#/components/MarkdownBody";
import { PrivacyMask } from "#/components/PrivacyMask";
import { Section } from "#/components/shell/Section";
import {
	ROW_EXPANDED,
	ROW_EXPANDED_INNER,
	RowChevron,
} from "#/components/vault/row";
import { VaultEmptyState } from "#/components/vault/VaultEmptyState";
import { groupSkills, type Skill } from "#/lib/skills";
import { matchesQuery } from "#/lib/vaultSearch";

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
					<RowChevron open={open} visible={!!skill.content} />
					<div className="min-w-0">
						<PrivacyMask className="text-sm text-foreground break-words">
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
				<div id={`skill-panel-${skill.file}`} className={ROW_EXPANDED}>
					<div className={ROW_EXPANDED_INNER}>
						<PrivacyMask>
							<MarkdownBody content={skill.content} />
						</PrivacyMask>
					</div>
				</div>
			)}
		</div>
	);
}

// ─── SkillsTab ────────────────────────────────────────────────────────────────

export function SkillsTab({
	skills,
	sectionOrder,
	onRun,
	query = "",
}: {
	skills: Skill[];
	sectionOrder: string[];
	onRun: (content: string) => void;
	query?: string;
}) {
	const filtered = useMemo(
		() =>
			skills.filter((s) =>
				matchesQuery(query, s.name, s.description, s.section),
			),
		[skills, query],
	);

	if (skills.length === 0) {
		return (
			<VaultEmptyState>
				no skills here yet, add{" "}
				<code className="font-mono text-primary">.md</code> files to your skills
				folder
			</VaultEmptyState>
		);
	}

	if (filtered.length === 0) {
		return <VaultEmptyState>no matches for “{query.trim()}”</VaultEmptyState>;
	}

	const groups = groupSkills(filtered, sectionOrder);

	return (
		<div className="space-y-6">
			{groups.map((g) => (
				<Section
					key={g.section ?? "__unsectioned__"}
					title={<PrivacyMask inline>{g.section ?? "SKILLS"}</PrivacyMask>}
					adornment={
						<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
					}
					count={g.skills.length}
				>
					{g.skills.map((s) => (
						<SkillCard key={s.file} skill={s} onRun={onRun} />
					))}
				</Section>
			))}
		</div>
	);
}
