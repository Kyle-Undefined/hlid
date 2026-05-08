import { RelativeFolderField } from "#/components/wizard/RelativeFolderField";
import { Field, PathField, Section, TextInput } from "./fields";

export type VaultForm = {
	style: "para" | "wiki";
	name: string;
	path: string;
	inbox: string;
	projects: string;
	areas: string;
	resources: string;
	archive: string;
	raw: string;
	wikiFolder: string;
	outputs: string;
	skills: string;
	memory: string;
};

export function VaultSection({
	vault,
	onChange,
}: {
	vault: VaultForm;
	onChange: (patch: Partial<VaultForm>) => void;
}) {
	return (
		<Section title="Vault">
			<div className="px-4 py-3 space-y-2">
				<div id="vault-style-label" className="text-sm text-foreground">
					Style
				</div>
				<div
					role="radiogroup"
					aria-labelledby="vault-style-label"
					className="grid grid-cols-2 gap-2"
				>
					{(
						[
							{
								value: "para" as const,
								label: "PARA",
								desc: "Inbox · Projects · Areas · Resources · Archive",
							},
							{
								value: "wiki" as const,
								label: "LLM Wiki",
								desc: "Raw · Wiki · Outputs",
							},
						] satisfies {
							value: "para" | "wiki";
							label: string;
							desc: string;
						}[]
					).map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => onChange({ style: opt.value })}
							aria-pressed={vault.style === opt.value}
							className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
								vault.style === opt.value
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent"
							}`}
						>
							<span className="text-sm font-medium text-foreground">
								{opt.label}
							</span>
							<span className="text-xs text-muted-foreground">{opt.desc}</span>
						</button>
					))}
				</div>
			</div>
			<Field label="Name">
				<TextInput value={vault.name} onChange={(v) => onChange({ name: v })} />
			</Field>
			<Field label="Path">
				<PathField value={vault.path} onChange={(v) => onChange({ path: v })} />
			</Field>
			{vault.style === "para" ? (
				<>
					<Field label="Inbox folder" hint="quick captures, unprocessed notes">
						<RelativeFolderField
							value={vault.inbox}
							onChange={(v) => onChange({ inbox: v })}
							basePath={vault.path}
							placeholder="00 Inbox"
						/>
					</Field>
					<Field
						label="Projects folder"
						hint="active work with a defined outcome"
					>
						<RelativeFolderField
							value={vault.projects}
							onChange={(v) => onChange({ projects: v })}
							basePath={vault.path}
							placeholder="10 Projects"
						/>
					</Field>
					<Field
						label="Areas folder"
						hint="ongoing responsibilities with no end date"
					>
						<RelativeFolderField
							value={vault.areas}
							onChange={(v) => onChange({ areas: v })}
							basePath={vault.path}
							placeholder="20 Areas"
						/>
					</Field>
					<Field
						label="Resources folder"
						hint="reference material organized by topic"
					>
						<RelativeFolderField
							value={vault.resources}
							onChange={(v) => onChange({ resources: v })}
							basePath={vault.path}
							placeholder="30 Resources"
						/>
					</Field>
					<Field
						label="Archive folder"
						hint="completed or inactive projects and areas"
					>
						<RelativeFolderField
							value={vault.archive}
							onChange={(v) => onChange({ archive: v })}
							basePath={vault.path}
							placeholder="40 Archive"
						/>
					</Field>
				</>
			) : (
				<>
					<Field label="Raw folder" hint="unprocessed notes / quick captures">
						<RelativeFolderField
							value={vault.raw}
							onChange={(v) => onChange({ raw: v })}
							basePath={vault.path}
							placeholder="raw"
						/>
					</Field>
					<Field
						label="Wiki folder"
						hint="curated knowledge pages, LLM-maintained"
					>
						<RelativeFolderField
							value={vault.wikiFolder}
							onChange={(v) => onChange({ wikiFolder: v })}
							basePath={vault.path}
							placeholder="wiki"
						/>
					</Field>
					<Field
						label="Outputs folder"
						hint="generated content, blog posts, essays"
					>
						<RelativeFolderField
							value={vault.outputs}
							onChange={(v) => onChange({ outputs: v })}
							basePath={vault.path}
							placeholder="outputs"
						/>
					</Field>
				</>
			)}
			<Field label="Skills folder" hint="vault skills (relative to vault path)">
				<RelativeFolderField
					value={vault.skills}
					onChange={(v) => onChange({ skills: v })}
					basePath={vault.path}
					placeholder=".claude/skills"
				/>
			</Field>
			<Field
				label="Memory folder"
				hint="vault memory files (relative to vault path)"
			>
				<RelativeFolderField
					value={vault.memory}
					onChange={(v) => onChange({ memory: v })}
					basePath={vault.path}
					placeholder=".claude/projects"
				/>
			</Field>
		</Section>
	);
}
