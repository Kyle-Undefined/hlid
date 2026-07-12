import { useState } from "react";

type HookArtifact = {
	agent: string;
	displayName: string;
	assets: { relativePath: string; contents: string; executable?: boolean }[];
	config: { fileName: string; settingsPath: string; contents: string };
};

const HOOK_AGENT_OPTIONS = ["claude", "codex", "cursor", "gemini"];

/** Generates per-agent hook wrapper + settings fragments for WSL or Windows. */
export function UmbodHooksPanel() {
	const [hookTarget, setHookTarget] = useState<"wsl" | "windows">("wsl");
	const [hookAgents, setHookAgents] = useState(["claude", "codex"]);
	const [hookArtifacts, setHookArtifacts] = useState<HookArtifact[]>([]);
	const [hookStatus, setHookStatus] = useState("");

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
		<section className="border border-border bg-card p-4 space-y-4">
			<div>
				<h3 className="text-sm font-medium">Generate agent hooks</h3>
				<p className="text-xs text-muted-foreground mt-1">
					Generate the actual wrapper and settings fragment for the environment
					where each agent runs.
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
				{HOOK_AGENT_OPTIONS.map((agent) => (
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
	);
}
