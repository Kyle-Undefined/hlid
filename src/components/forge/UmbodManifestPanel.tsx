import { useEffect, useState } from "react";
import type { UmbodSnapshot } from "#/components/forge/UmbodSection";
import type { HlidConfig } from "#/config";

/** Manifest editor: enable toggle, path, TOML source, validate & save, rule-finding summary. */
export function UmbodManifestPanel({
	value,
	onChange,
	snapshot,
	onSaved,
}: {
	value: HlidConfig["umbod"];
	onChange: (next: HlidConfig["umbod"]) => void;
	snapshot: UmbodSnapshot | null;
	onSaved: () => Promise<void>;
}) {
	const [source, setSource] = useState("");
	const [status, setStatus] = useState("");

	useEffect(() => {
		if (snapshot?.source !== undefined) setSource(snapshot.source);
	}, [snapshot?.source]);

	async function save() {
		setStatus("Validating manifest…");
		const response = await fetch("/api/umbod", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source }),
		});
		const body = (await response.json()) as { error?: string };
		setStatus(
			response.ok
				? "Manifest validated and saved"
				: (body.error ?? "Manifest validation or save failed"),
		);
		if (response.ok) await onSaved();
	}

	return (
		<section className="min-w-0 space-y-4 border border-border bg-card p-4">
			<div className="flex min-w-0 flex-col items-start gap-3 @2xl:flex-row @2xl:justify-between">
				<div className="min-w-0">
					<h3 className="text-sm font-medium">Umbod policy</h3>
					<p className="mt-1 break-words text-xs text-muted-foreground">
						Enforce tool policy before provider permission shortcuts. Explicit
						blocks also apply in bypass mode.
					</p>
				</div>
				<label className="flex shrink-0 items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={value.enabled}
						onChange={(event) =>
							onChange({ ...value, enabled: event.target.checked })
						}
					/>
					Enabled
				</label>
			</div>
			<label className="block text-xs space-y-1">
				<span className="text-muted-foreground">Manifest path</span>
				<input
					className="w-full bg-input border border-border px-3 py-2"
					value={value.manifest_path}
					onChange={(event) =>
						onChange({ ...value, manifest_path: event.target.value })
					}
				/>
			</label>
			<textarea
				aria-label="Umbod manifest TOML"
				spellCheck={false}
				className="w-full min-h-64 bg-input border border-border p-3 font-mono text-xs"
				value={source}
				onChange={(event) => setSource(event.target.value)}
			/>
			<div className="flex min-w-0 flex-wrap items-center gap-3">
				<button
					type="button"
					onClick={() => void save()}
					className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Validate & save
				</button>
				<button
					type="button"
					onClick={() => void onSaved()}
					className="px-3 py-1.5 text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
				>
					Reload insights
				</button>
				<span className="min-w-0 break-words [overflow-wrap:anywhere] text-xs text-muted-foreground">
					{status || snapshot?.error}
				</span>
			</div>
			<p className="text-[10px] text-muted-foreground">
				Validation checks the manifest. Match-history labels below describe
				recorded tool calls and do not affect whether the manifest saved.
			</p>
			{snapshot?.enabled && (
				<div className="grid gap-3 md:grid-cols-2 text-xs">
					<div className="border border-border p-3">
						<div className="text-muted-foreground uppercase tracking-wider text-[10px]">
							Tool calls
						</div>
						<div className="text-2xl mt-1">
							{snapshot.analyticsLoading
								? "…"
								: (snapshot.tools?.totals?.entries ?? 0)}
						</div>
					</div>
					<div className="border border-border p-3">
						<div className="text-muted-foreground uppercase tracking-wider text-[10px]">
							Rule analysis findings
						</div>
						<div className="text-2xl mt-1">
							{snapshot.analyticsLoading
								? "…"
								: (snapshot.rules?.rules?.filter(
										(rule) => rule.status !== "active",
									).length ?? 0)}
						</div>
					</div>
				</div>
			)}
			{snapshot?.rules?.tomlSnippet && (
				<pre className="overflow-auto border border-border bg-secondary p-3 text-xs">
					{snapshot.rules.tomlSnippet}
				</pre>
			)}
		</section>
	);
}
