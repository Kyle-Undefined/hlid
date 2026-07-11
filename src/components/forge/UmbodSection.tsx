import { useCallback, useEffect, useState } from "react";
import { UmbodDashboard } from "#/components/forge/UmbodDashboard";
import type { HlidConfig } from "#/config";

type Snapshot = {
	enabled: boolean;
	source?: string;
	error?: string;
	tools?: {
		totals?: {
			entries?: number;
			sessions?: number;
			agents?: string[];
			projects?: string[];
		};
		byTool?: {
			agent: string;
			tool: string;
			count: number;
			decisions: { allow: number; approve: number; block: number };
		}[];
	};
	rules?: {
		rules?: {
			pattern: string;
			decision: string;
			status: string;
			matchCount: number;
		}[];
		tomlSnippet?: string;
	};
};

type HookArtifact = {
	agent: string;
	displayName: string;
	assets: { relativePath: string; contents: string; executable?: boolean }[];
	config: { fileName: string; settingsPath: string; contents: string };
};

export function UmbodSection({
	value,
	onChange,
}: {
	value: HlidConfig["umbod"];
	onChange: (next: HlidConfig["umbod"]) => void;
}) {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [source, setSource] = useState("");
	const [status, setStatus] = useState("");
	const [hookTarget, setHookTarget] = useState<"wsl" | "windows">("wsl");
	const [hookAgents, setHookAgents] = useState(["claude", "codex"]);
	const [hookArtifacts, setHookArtifacts] = useState<HookArtifact[]>([]);
	const [hookStatus, setHookStatus] = useState("");
	const load = useCallback(async () => {
		const response = await fetch("/api/umbod");
		const body = (await response.json()) as Snapshot;
		setSnapshot(body);
		if (body.source !== undefined) setSource(body.source);
	}, []);
	useEffect(() => void load(), [load]);
	async function save() {
		setStatus("Validating…");
		const response = await fetch("/api/umbod", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ source }),
		});
		const body = (await response.json()) as { error?: string };
		setStatus(response.ok ? "Manifest saved" : (body.error ?? "Save failed"));
		if (response.ok) await load();
	}
	async function generateHooks() {
		setHookStatus("Generating…");
		const response = await fetch("/api/umbod", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: "generate-hooks",
				target: hookTarget,
				agents: hookAgents,
			}),
		});
		const body = (await response.json()) as {
			artifacts?: HookArtifact[];
			error?: string;
		};
		setHookArtifacts(body.artifacts ?? []);
		setHookStatus(response.ok ? "Artifacts ready" : (body.error ?? "Failed"));
	}
	return (
		<div className="space-y-6">
			<section className="border border-border bg-card p-4 space-y-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h3 className="text-sm font-medium">Umbod policy</h3>
						<p className="text-xs text-muted-foreground mt-1">
							Enforce tool policy before provider permission shortcuts. Explicit
							blocks also apply in bypass mode.
						</p>
					</div>
					<label className="flex items-center gap-2 text-xs">
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
						className="w-full bg-secondary border border-border px-3 py-2"
						value={value.manifest_path}
						onChange={(event) =>
							onChange({ ...value, manifest_path: event.target.value })
						}
					/>
				</label>
				<textarea
					aria-label="Umbod manifest TOML"
					spellCheck={false}
					className="w-full min-h-64 bg-secondary border border-border p-3 font-mono text-xs"
					value={source}
					onChange={(event) => setSource(event.target.value)}
				/>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => void save()}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
					>
						Validate & save
					</button>
					<button
						type="button"
						onClick={() => void load()}
						className="px-3 py-1.5 text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
					>
						Reload insights
					</button>
					<span className="text-xs text-muted-foreground">
						{status || snapshot?.error}
					</span>
				</div>
				{snapshot?.enabled && (
					<div className="grid gap-3 md:grid-cols-2 text-xs">
						<div className="border border-border p-3">
							<div className="text-muted-foreground uppercase tracking-wider text-[10px]">
								Tool calls
							</div>
							<div className="text-2xl mt-1">
								{snapshot.tools?.totals?.entries ?? 0}
							</div>
						</div>
						<div className="border border-border p-3">
							<div className="text-muted-foreground uppercase tracking-wider text-[10px]">
								Rule findings
							</div>
							<div className="text-2xl mt-1">
								{snapshot.rules?.rules?.filter(
									(rule) => rule.status !== "active",
								).length ?? 0}
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
			<section className="border border-border bg-card p-4 space-y-4">
				<div>
					<h3 className="text-sm font-medium">Generate agent hooks</h3>
					<p className="text-xs text-muted-foreground mt-1">
						Generate the actual wrapper and settings fragment for the
						environment where each agent runs.
					</p>
				</div>
				<div className="flex flex-wrap gap-4 text-xs">
					<label>
						<input
							type="radio"
							checked={hookTarget === "wsl"}
							onChange={() => setHookTarget("wsl")}
						/>{" "}
						WSL
					</label>
					<label>
						<input
							type="radio"
							checked={hookTarget === "windows"}
							onChange={() => setHookTarget("windows")}
						/>{" "}
						Windows
					</label>
					{["claude", "codex", "cursor", "gemini"].map((agent) => (
						<label key={agent}>
							<input
								type="checkbox"
								checked={hookAgents.includes(agent)}
								onChange={(event) =>
									setHookAgents((current) =>
										event.target.checked
											? [...current, agent]
											: current.filter((item) => item !== agent),
									)
								}
							/>{" "}
							{agent}
						</label>
					))}
				</div>
				<button
					type="button"
					disabled={hookAgents.length === 0}
					onClick={() => void generateHooks()}
					className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase hover:bg-accent"
				>
					Generate
				</button>
				<span className="ml-3 text-xs text-muted-foreground">{hookStatus}</span>
				{hookTarget === "wsl" && (
					<p className="border-l-2 border-primary/40 pl-3 text-xs text-muted-foreground">
						These wrappers call the Umbod server hosted by Windows. No Umbod CLI
						or second Umbod server is required inside WSL.
					</p>
				)}
				{hookArtifacts.map((artifact) => (
					<div
						key={artifact.agent}
						className="border border-border p-3 space-y-3"
					>
						<h4 className="text-xs font-medium">{artifact.displayName}</h4>
						{artifact.assets.map((asset) => (
							<div key={asset.relativePath} className="space-y-1">
								<div className="flex justify-between gap-3 text-[10px] text-muted-foreground">
									<span>
										Save as{" "}
										{hookTarget === "wsl"
											? `~/.umbod/${asset.relativePath}`
											: asset.relativePath}
										{asset.executable ? " and chmod +x" : ""}
									</span>
									<button
										type="button"
										onClick={() =>
											void navigator.clipboard.writeText(asset.contents)
										}
										className="shrink-0 uppercase tracking-wider hover:text-foreground"
									>
										Copy wrapper
									</button>
								</div>
								<pre className="max-h-64 select-text overflow-auto whitespace-pre bg-secondary border border-border p-3 text-[10px]">
									{asset.contents}
								</pre>
							</div>
						))}
						<div className="space-y-1">
							<div className="flex justify-between gap-3 text-[10px] text-muted-foreground">
								<span>Merge into {artifact.config.settingsPath}</span>
								<button
									type="button"
									onClick={() =>
										void navigator.clipboard.writeText(artifact.config.contents)
									}
									className="shrink-0 uppercase tracking-wider hover:text-foreground"
								>
									Copy settings
								</button>
							</div>
							<pre className="max-h-64 select-text overflow-auto whitespace-pre bg-secondary border border-border p-3 text-[10px]">
								{artifact.config.contents}
							</pre>
						</div>
					</div>
				))}
			</section>
			<UmbodDashboard tools={snapshot?.tools} rules={snapshot?.rules} />
		</div>
	);
}
