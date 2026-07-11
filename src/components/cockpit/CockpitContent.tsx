import type { ActiveCockpitSkill } from "#/components/cockpit/CockpitPrompt";
import { SkillCard } from "#/components/cockpit/SkillCard";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { getConfig } from "#/config";
import type { groupSkills } from "#/lib/skills";

type CockpitConfig = Awaited<ReturnType<typeof getConfig>>;
type SkillGroups = ReturnType<typeof groupSkills>;

export function CockpitHeader({
	config,
	modelShort,
}: {
	config: CockpitConfig;
	modelShort: string | null;
}) {
	return (
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
	);
}

export function CockpitRunError({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<div className="px-4 py-2 border-b border-destructive/20 bg-destructive/5 shrink-0">
			<span className="text-[10px] tracking-wider text-destructive/80">
				ERR: {error}
			</span>
		</div>
	);
}

function SkillGroup({
	group,
	activeSkill,
	onSelect,
}: {
	group: SkillGroups[number];
	activeSkill: ActiveCockpitSkill | null;
	onSelect: (skill: SkillGroups[number]["skills"][number]) => void;
}) {
	return (
		<div className="space-y-2 min-w-0">
			<div className="flex items-center gap-2">
				<span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
				<PrivacyMask
					inline
					className="text-[10px] tracking-widest text-muted-foreground uppercase"
				>
					{group.section ?? "SKILLS"}
				</PrivacyMask>
				<span className="text-[10px] text-muted-foreground/50">
					{group.skills.length}
				</span>
			</div>
			<div className="grid grid-cols-2 gap-2 md:grid-cols-1">
				{group.skills.map((skill) => (
					<SkillCard
						key={skill.file}
						skill={skill}
						active={activeSkill?.name === skill.name}
						onSelect={onSelect}
					/>
				))}
			</div>
		</div>
	);
}

export function CockpitSkills({
	hasSkills,
	groups,
	activeSkill,
	onSelect,
}: {
	hasSkills: boolean;
	groups: SkillGroups;
	activeSkill: ActiveCockpitSkill | null;
	onSelect: (skill: SkillGroups[number]["skills"][number]) => void;
}) {
	if (!hasSkills) {
		return (
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
		);
	}
	return (
		<div className="p-4 grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-5">
			{groups.map((group) => (
				<SkillGroup
					key={group.section ?? "__unsectioned__"}
					group={group}
					activeSkill={activeSkill}
					onSelect={onSelect}
				/>
			))}
		</div>
	);
}
