import type {
	ExtensionComponent,
	ExtensionSkillFile,
} from "#/server/extensionInventory";

export function ExtensionMetaValue({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	if (!value) return null;
	return (
		<div className="min-w-0">
			<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
				{label}
			</div>
			<div className={`mt-0.5 text-xs break-all ${mono ? "font-mono" : ""}`}>
				{value}
			</div>
		</div>
	);
}

export function ExtensionComponents({
	components,
}: {
	components: ExtensionComponent[];
}) {
	if (components.length === 0) return null;
	return (
		<div>
			<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
				Bundled components
			</div>
			<div className="mt-2 flex flex-wrap gap-1.5">
				{components.map((component) => (
					<span
						key={component.kind}
						title={component.names.join(", ")}
						className="border border-border bg-secondary px-2 py-1 text-[10px]"
					>
						{component.label} · {component.count}
					</span>
				))}
			</div>
		</div>
	);
}

function PackageFilesReview({ files }: { files: ExtensionSkillFile[] }) {
	if (files.length === 0) return null;
	return (
		<div>
			<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
				Package files · {files.length}
			</div>
			<div className="mt-2 space-y-2">
				{files.map((file) => (
					<details
						key={file.path}
						className="border border-border/70 bg-secondary/30"
					>
						<summary className="cursor-pointer px-3 py-2 text-[10px] font-mono break-all">
							{file.path}
							{file.size !== undefined
								? ` · ${file.size.toLocaleString()} bytes`
								: ""}
						</summary>
						<div className="border-t border-border/70">
							{file.truncated && (
								<div className="border-b border-status-warning/20 bg-status-warning/5 px-3 py-2 text-[10px] text-status-warning">
									Preview truncated at the extension review limit.
								</div>
							)}
							{file.binary ? (
								<div className="p-3 text-[10px] text-muted-foreground">
									Binary file. Content is not rendered in the review.
								</div>
							) : (
								<pre className="max-h-[32rem] overflow-auto p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
									{file.content}
								</pre>
							)}
						</div>
					</details>
				))}
			</div>
		</div>
	);
}

export function TrustReviewAndManifest({
	skillFiles,
	trustSignals,
	trustFallbackMessage,
	manifestSummary,
	manifestPath,
	manifestText,
}: {
	skillFiles: ExtensionSkillFile[];
	trustSignals: string[];
	trustFallbackMessage: string;
	manifestSummary: string;
	manifestPath: string;
	manifestText: string;
}) {
	return (
		<>
			<PackageFilesReview files={skillFiles} />
			<div>
				<div className="text-[9px] tracking-widest uppercase text-muted-foreground">
					Trust review
				</div>
				{trustSignals.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{[...new Set(trustSignals)].map((signal) => (
							<span
								key={signal}
								className="border border-status-warning/30 bg-status-warning/5 px-2 py-1 text-[10px] text-status-warning"
							>
								{signal}
							</span>
						))}
					</div>
				) : (
					<p className="mt-1 text-xs text-muted-foreground">
						{trustFallbackMessage}
					</p>
				)}
			</div>
			<details className="border border-border/70 bg-secondary/30">
				<summary className="cursor-pointer px-3 py-2 text-[10px] tracking-widest uppercase">
					{manifestSummary}
				</summary>
				<div className="border-t border-border/70">
					<div className="px-3 py-2 text-[10px] font-mono text-muted-foreground break-all">
						{manifestPath}
					</div>
					<pre className="max-h-96 overflow-auto border-t border-border/70 p-3 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
						{manifestText}
					</pre>
				</div>
			</details>
		</>
	);
}
