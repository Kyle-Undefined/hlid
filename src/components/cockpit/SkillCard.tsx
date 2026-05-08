import { PrivacyMask } from "#/components/PrivacyMask";
import type { Skill } from "#/lib/vault";

export function SkillCard({
	skill,
	active,
	onSelect,
}: {
	skill: Skill;
	active: boolean;
	onSelect: (skill: Skill) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(skill)}
			aria-pressed={active}
			className={`flex flex-col w-full px-3 py-2 border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 ${
				active
					? "border-primary/40 bg-primary/[0.08]"
					: "border-border bg-card hover:border-primary/20 hover:bg-primary/[0.03]"
			}`}
		>
			<PrivacyMask
				className={`text-[11px] tracking-wider font-medium uppercase truncate w-full ${
					active ? "text-primary" : "text-foreground/80"
				}`}
			>
				{skill.name}
			</PrivacyMask>
			{skill.description && (
				<PrivacyMask className="text-[9px] tracking-wider text-muted-foreground/70 truncate w-full mt-0.5">
					{skill.description}
				</PrivacyMask>
			)}
		</button>
	);
}
