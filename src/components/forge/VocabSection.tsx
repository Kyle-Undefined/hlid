import { Section, VocabRow } from "./fields";

export type VocabForm = {
	active: string;
	planning: string;
	done: string;
};

export function VocabSection({
	vocab,
	onChange,
}: {
	vocab: VocabForm;
	onChange: (patch: Partial<VocabForm>) => void;
}) {
	return (
		<Section title="Status Vocabulary">
			<VocabRow
				label="Active"
				value={vocab.active}
				onChange={(v) => onChange({ active: v })}
			/>
			<VocabRow
				label="Planning"
				value={vocab.planning}
				onChange={(v) => onChange({ planning: v })}
			/>
			<VocabRow
				label="Done"
				value={vocab.done}
				onChange={(v) => onChange({ done: v })}
			/>
		</Section>
	);
}
