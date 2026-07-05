import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { ApiSection } from "#/components/forge/ApiSection";
import type { ClaudeForm } from "#/components/forge/ClaudeSection";
import { ClaudeSection } from "#/components/forge/ClaudeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { McpSection } from "#/components/forge/McpSection";
import type { ServerForm } from "#/components/forge/NetworkSection";
import { NetworkSection } from "#/components/forge/NetworkSection";
import { SessionSection } from "#/components/forge/SessionSection";
import { SystemSection } from "#/components/forge/SystemSection";
import type { UiForm } from "#/components/forge/UiSection";
import { UiSection } from "#/components/forge/UiSection";
import { UpdatesSection } from "#/components/forge/UpdatesSection";
import type { VaultForm } from "#/components/forge/VaultSection";
import { VaultSection } from "#/components/forge/VaultSection";
import type { VocabForm } from "#/components/forge/VocabSection";
import { VocabSection } from "#/components/forge/VocabSection";
import type { HlidConfig } from "#/config";
import { DEFAULT_ATTACHMENTS_CONFIG, getConfig } from "#/config";
import { getAccountInfoFn, getProvidersFn } from "#/lib/serverFns";
import { buildVaultSection } from "#/lib/vaultConfig";

// ─── Server functions ─────────────────────────────────────────────────────────

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd, providers, accountInfo] = await Promise.all([
			getConfig(),
			getCwdFn(),
			getProvidersFn(),
			getAccountInfoFn(),
		]);
		return { ...config, cwd, providers, accountInfo };
	},
	component: SettingsPage,
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
	"general",
	"network",
	"vault",
	"agent",
	"interface",
	"logs",
	"api",
] as const;
type Tab = (typeof TABS)[number];

type CodexForm = {
	model: string;
	effort: HlidConfig["codex"]["effort"];
	maxTurns: string;
	permissionMode: HlidConfig["codex"]["permission_mode"];
	turnRecaps: boolean;
	recapModel: string;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

function SettingsPage() {
	const initial = Route.useLoaderData();
	const router = useRouter();

	const [tab, setTab] = useState<Tab>("general");

	const [vault, setVault] = useState<VaultForm>({
		style: initial.vault.style ?? "para",
		name: initial.vault.name,
		path: initial.vault.path,
		inbox: initial.vault.inbox ?? "",
		projects: initial.vault.projects ?? "",
		areas: initial.vault.areas ?? "",
		resources: initial.vault.resources ?? "",
		archive: initial.vault.archive ?? "",
		raw: initial.vault.raw ?? "",
		wikiFolder: initial.vault.wiki_folder ?? "",
		outputs: initial.vault.outputs ?? "",
		skills: initial.vault.skills ?? "",
		memory: initial.vault.memory ?? "",
	});

	const [claude, setClaude] = useState<ClaudeForm>({
		model: initial.claude.model,
		effort: initial.claude.effort,
		maxTurns:
			initial.claude.max_turns !== undefined
				? String(initial.claude.max_turns)
				: "",
		permissionMode: initial.claude.permission_mode,
		turnRecaps: initial.claude.turn_recaps ?? true,
		recapModel: initial.claude.recap_model ?? "",
		vaultProvider: initial.vault_provider ?? "claude",
		interactiveMode: initial.claude.interactive_mode ?? false,
	});
	const [codex, setCodex] = useState<CodexForm>({
		model: initial.codex.model,
		effort: initial.codex.effort,
		maxTurns:
			initial.codex.max_turns !== undefined
				? String(initial.codex.max_turns)
				: "",
		permissionMode: initial.codex.permission_mode,
		turnRecaps: initial.codex.turn_recaps ?? true,
		recapModel: initial.codex.recap_model ?? "",
	});

	const [server, setServer] = useState<ServerForm>({
		port: String(initial.server.port),
		tlsCertPath: initial.server.tls_cert_path ?? "",
		tlsKeyPath: initial.server.tls_key_path ?? "",
		tlsProxyPort:
			initial.server.tls_proxy_port != null
				? String(initial.server.tls_proxy_port)
				: "",
		localNetworkAccess: initial.server.local_network_access ?? false,
		allowExternalAgents: initial.server.allow_external_agents ?? false,
	});

	const [ui, setUi] = useState<UiForm>({
		theme: initial.ui.theme,
		mobileTheme: initial.ui.mobile_theme ?? "same",
		enterToSubmit: initial.ui.enter_to_submit,
		hideSkillsIndex: initial.ui.hide_skills_index,
	});

	const [vocab, setVocab] = useState<VocabForm>({
		active: initial.status_vocabulary.active.join(", "),
		planning: initial.status_vocabulary.planning.join(", "),
		done: initial.status_vocabulary.done.join(", "),
	});

	const [saving, setSaving] = useState(false);
	const [savedMsg, setSavedMsg] = useState<"saved" | "restart" | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Stable refs to initial state — new object refs are only created when the
	// user edits, so reference equality detects real changes without a mount guard
	// (which breaks under React StrictMode's double-invoke).
	const initialStateRef = useRef({ vault, claude, codex, ui, vocab });
	const saveRef = useRef<((requiresRestart?: boolean) => Promise<void>) | null>(
		null,
	);

	async function save(requiresRestart = false) {
		setSaving(true);
		setError(null);
		setSavedMsg(null);

		const config: HlidConfig = {
			vault_provider: claude.vaultProvider,
			vault: buildVaultSection(vault),
			// For auto-save, keep persisted server values so in-progress network
			// edits don't commit without an explicit save.
			server: requiresRestart
				? {
						port: Number(server.port) || 3000,
						tls_cert_path: server.tlsCertPath || undefined,
						tls_key_path: server.tlsKeyPath || undefined,
						tls_proxy_port: Number(server.tlsProxyPort) || 3443,
						local_network_access: server.localNetworkAccess,
						allow_external_agents: server.allowExternalAgents,
					}
				: initial.server,
			claude: {
				model: claude.model,
				effort: claude.effort,
				max_turns:
					claude.maxTurns !== "" && !Number.isNaN(Number(claude.maxTurns))
						? Number(claude.maxTurns)
						: undefined,
				permission_mode: claude.permissionMode,
				turn_recaps: claude.turnRecaps,
				recap_model: claude.recapModel || undefined,
				interactive_mode: claude.interactiveMode,
			},
			codex: {
				model: codex.model,
				effort: codex.effort,
				max_turns:
					codex.maxTurns !== "" && !Number.isNaN(Number(codex.maxTurns))
						? Number(codex.maxTurns)
						: undefined,
				permission_mode: codex.permissionMode,
				turn_recaps: codex.turnRecaps,
				recap_model: codex.recapModel || undefined,
				executable: initial.codex.executable,
			},
			ui: {
				enter_to_submit: ui.enterToSubmit,
				hide_skills_index: ui.hideSkillsIndex,
				theme: ui.theme,
				mobile_theme: ui.mobileTheme === "same" ? undefined : ui.mobileTheme,
			},
			status_vocabulary: {
				active: vocab.active
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				planning: vocab.planning
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				done: vocab.done
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			},
			attachments: initial.attachments ?? DEFAULT_ATTACHMENTS_CONFIG,
			agents: initial.agents ?? [],
		};

		try {
			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			if (!res.ok) {
				let msg = "Save failed";
				try {
					const body = (await res.json()) as { error?: string };
					if (body.error) msg = body.error;
				} catch {}
				throw new Error(msg);
			}
			setSavedMsg(requiresRestart ? "restart" : "saved");
			setTimeout(() => setSavedMsg(null), 3000);
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}
	saveRef.current = save;

	// Auto-save vault/provider/ui/vocab changes — server settings require explicit save.
	useEffect(() => {
		const init = initialStateRef.current;
		if (
			vault === init.vault &&
			claude === init.claude &&
			codex === init.codex &&
			ui === init.ui &&
			vocab === init.vocab
		)
			return;
		const timer = setTimeout(() => void saveRef.current?.(false), 800);
		return () => clearTimeout(timer);
	}, [vault, claude, codex, ui, vocab]);

	const showSaveButton = tab === "network";
	const showSaveBar =
		showSaveButton ||
		(tab !== "logs" &&
			tab !== "general" &&
			(savedMsg !== null || error !== null));

	return (
		<div className="flex flex-col h-full">
			{/* Tab nav */}
			<div className="flex flex-wrap border-b border-border shrink-0">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						onClick={() => setTab(t)}
						aria-pressed={tab === t}
						className={`px-5 py-2.5 text-[10px] tracking-widest uppercase transition-colors border-b-2 -mb-px ${
							tab === t
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
					>
						{t}
					</button>
				))}
			</div>

			<div className="flex-1 overflow-auto p-5 space-y-6">
				{tab === "general" && (
					<>
						<UpdatesSection />
						<SystemSection />
						<SessionSection />
					</>
				)}
				{tab === "network" && (
					<NetworkSection
						server={server}
						onChange={(p) => setServer((s) => ({ ...s, ...p }))}
						cwd={initial.cwd}
					/>
				)}
				{tab === "vault" && (
					<>
						<VaultSection
							vault={vault}
							onChange={(p) => setVault((s) => ({ ...s, ...p }))}
						/>
						<VocabSection
							vocab={vocab}
							onChange={(p) => setVocab((s) => ({ ...s, ...p }))}
						/>
						<McpSection vaultPath={vault.path} />
					</>
				)}
				{tab === "agent" && (
					<ClaudeSection
						claude={
							claude.vaultProvider === "codex"
								? {
										...codex,
										vaultProvider: claude.vaultProvider,
										interactiveMode: claude.interactiveMode,
									}
								: claude
						}
						onChange={(p) => {
							const vaultProvider = p.vaultProvider;
							if (vaultProvider) {
								setClaude((s) => ({ ...s, vaultProvider }));
								return;
							}
							if (claude.vaultProvider === "codex") {
								setCodex((s) => ({
									...s,
									...(p.model !== undefined ? { model: p.model } : {}),
									...(p.effort !== undefined
										? { effort: p.effort as CodexForm["effort"] }
										: {}),
									...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
									...(p.permissionMode !== undefined
										? {
												permissionMode:
													p.permissionMode as CodexForm["permissionMode"],
											}
										: {}),
									...(p.turnRecaps !== undefined
										? { turnRecaps: p.turnRecaps }
										: {}),
									...(p.recapModel !== undefined
										? { recapModel: p.recapModel }
										: {}),
								}));
							} else {
								setClaude((s) => ({ ...s, ...p }));
							}
						}}
						providers={initial.providers}
						accountInfo={initial.accountInfo}
					/>
				)}
				{tab === "interface" && (
					<UiSection ui={ui} onChange={(p) => setUi((s) => ({ ...s, ...p }))} />
				)}
				{tab === "logs" && <EventLogSection />}
				{tab === "api" && <ApiSection />}
			</div>

			{showSaveBar && (
				<div className="shrink-0 border-t border-border bg-background/95 px-5 py-3 flex items-center justify-between gap-4">
					<div className="text-xs tracking-wider">
						{error && <span className="text-destructive">{error}</span>}
						{savedMsg === "saved" && (
							<span className="text-green-500">Changes saved.</span>
						)}
						{savedMsg === "restart" && (
							<span className="text-green-500">
								Changes saved. Restart required.
							</span>
						)}
					</div>
					{showSaveButton && (
						<button
							type="button"
							onClick={() => void save(true)}
							disabled={saving}
							className="px-4 py-2 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 uppercase"
						>
							{saving ? "SAVING…" : "SAVE CHANGES"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
