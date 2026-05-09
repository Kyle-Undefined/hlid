import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { ClaudeForm } from "#/components/forge/ClaudeSection";
import { ClaudeSection } from "#/components/forge/ClaudeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { McpSection } from "#/components/forge/McpSection";
import type { ServerForm } from "#/components/forge/ServerSection";
import { ServerSection } from "#/components/forge/ServerSection";
import { SessionSection } from "#/components/forge/SessionSection";
import { SystemSection } from "#/components/forge/SystemSection";
import { TailscaleSection } from "#/components/forge/TailscaleSection";
import type { UiForm } from "#/components/forge/UiSection";
import { UiSection } from "#/components/forge/UiSection";
import { UpdatesSection } from "#/components/forge/UpdatesSection";
import type { VaultForm } from "#/components/forge/VaultSection";
import { VaultSection } from "#/components/forge/VaultSection";
import type { VocabForm } from "#/components/forge/VocabSection";
import { VocabSection } from "#/components/forge/VocabSection";
import type { HlidConfig } from "#/config";
import { DEFAULT_ATTACHMENTS_CONFIG, getConfig } from "#/config";
import { getProvidersFn } from "#/lib/serverFns";
import { buildVaultSection } from "#/lib/vaultConfig";

// ─── Server functions ─────────────────────────────────────────────────────────

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd, providers] = await Promise.all([
			getConfig(),
			getCwdFn(),
			getProvidersFn(),
		]);
		return { ...config, cwd, providers };
	},
	component: SettingsPage,
});

// ─── Page ─────────────────────────────────────────────────────────────────────

function SettingsPage() {
	const initial = Route.useLoaderData();
	const router = useRouter();

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
		vaultProvider: initial.vault_provider ?? "claude",
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
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setSaving(true);
		setError(null);
		setSaved(false);

		const config: HlidConfig = {
			vault_provider: claude.vaultProvider,
			vault: buildVaultSection(vault),
			server: {
				port: Number(server.port) || 3000,
				tls_cert_path: server.tlsCertPath || undefined,
				tls_key_path: server.tlsKeyPath || undefined,
				tls_proxy_port: Number(server.tlsProxyPort) || 3443,
				local_network_access: server.localNetworkAccess,
				allow_external_agents: server.allowExternalAgents,
			},
			claude: {
				model: claude.model,
				effort: claude.effort,
				max_turns:
					claude.maxTurns !== "" && !Number.isNaN(Number(claude.maxTurns))
						? Number(claude.maxTurns)
						: undefined,
				permission_mode: claude.permissionMode,
				turn_recaps: claude.turnRecaps,
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
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto p-5 space-y-6">
				<UpdatesSection />
				<SystemSection />
				<ServerSection
					server={server}
					onChange={(p) => setServer((s) => ({ ...s, ...p }))}
				/>
				<TailscaleSection
					tlsProxyPort={server.tlsProxyPort}
					setTlsProxyPort={(v) => setServer((s) => ({ ...s, tlsProxyPort: v }))}
					tlsCertPath={server.tlsCertPath}
					setTlsCertPath={(v) => setServer((s) => ({ ...s, tlsCertPath: v }))}
					tlsKeyPath={server.tlsKeyPath}
					setTlsKeyPath={(v) => setServer((s) => ({ ...s, tlsKeyPath: v }))}
					localNetworkAccess={server.localNetworkAccess}
					cwd={initial.cwd}
				/>
				<SessionSection />
				<UiSection ui={ui} onChange={(p) => setUi((s) => ({ ...s, ...p }))} />
				<VaultSection
					vault={vault}
					onChange={(p) => setVault((s) => ({ ...s, ...p }))}
				/>
				<VocabSection
					vocab={vocab}
					onChange={(p) => setVocab((s) => ({ ...s, ...p }))}
				/>
				<McpSection vaultPath={vault.path} />
				<ClaudeSection
					claude={claude}
					onChange={(p) => setClaude((s) => ({ ...s, ...p }))}
					providers={initial.providers}
				/>
				<EventLogSection />
			</div>

			{/* Save bar */}
			<div className="shrink-0 border-t border-border bg-background/95 px-5 py-3 flex items-center justify-between gap-4">
				<div className="text-xs tracking-wider">
					{error && <span className="text-destructive">{error}</span>}
					{saved && (
						<span className="text-green-500">
							saved, reload session to apply changes
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 uppercase"
				>
					{saving ? "SAVING…" : "SAVE CHANGES"}
				</button>
			</div>
		</div>
	);
}
