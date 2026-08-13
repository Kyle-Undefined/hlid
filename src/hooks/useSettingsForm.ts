import { useEffect, useRef, useState } from "react";
import type { ClaudeForm } from "#/components/forge/ClaudeSection";
import { usePublishNavigationNames } from "#/components/nav/NavigationNamesContext";
import type { HlidConfig } from "#/config";
import type { getAcpRegistryFn } from "#/lib/serverFns/acp";
import type { getCliProxyInfoFn } from "#/lib/serverFns/cliproxy";
import type {
	getAccountInfoFn,
	getProvidersFn,
} from "#/lib/serverFns/providers";
import type { getVoiceInfoFn } from "#/lib/serverFns/voice";
import {
	applyAgentFormPatch,
	buildSettingsConfig,
	createSettingsForms,
} from "#/lib/settingsForm";

export type SettingsInitial = HlidConfig & {
	cwd: string;
	providers: Awaited<ReturnType<typeof getProvidersFn>>;
	accountInfo: Awaited<ReturnType<typeof getAccountInfoFn>>;
	voiceInfo: Awaited<ReturnType<typeof getVoiceInfoFn>>;
	cliProxyInfo: Awaited<ReturnType<typeof getCliProxyInfoFn>>;
	acpCatalog: Awaited<ReturnType<typeof getAcpRegistryFn>>;
};

async function responseError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error || "Save failed";
	} catch {
		return "Save failed";
	}
}

async function responseResult(response: Response): Promise<{
	warning: string | null;
	acpRuntimeSynced: boolean;
}> {
	try {
		const body = (await response.json()) as {
			warning?: unknown;
			acp_runtime_synced?: unknown;
		};
		return {
			warning:
				typeof body.warning === "string" && body.warning.trim()
					? body.warning.trim()
					: null,
			acpRuntimeSynced: body.acp_runtime_synced !== false,
		};
	} catch {
		return { warning: null, acpRuntimeSynced: true };
	}
}

export function useSettingsForm(
	initial: SettingsInitial,
	onSaved: () => Promise<void>,
) {
	const publishNavigationNames = usePublishNavigationNames();
	const initialFormsRef = useRef(createSettingsForms(initial));
	const initialForms = initialFormsRef.current;
	const [vault, setVault] = useState(initialForms.vault);
	const [persistedVaultPath, setPersistedVaultPath] = useState(
		initialForms.vault.path,
	);
	const [claude, setClaude] = useState(initialForms.claude);
	const [codex, setCodex] = useState(initialForms.codex);
	const [cliproxy, setCliProxy] = useState(initialForms.cliproxy);
	const [voice, setVoice] = useState(initialForms.voice);
	const [acpAgents, setAcpAgents] = useState(initialForms.acpAgents);
	const [persistedAcpAgents, setPersistedAcpAgents] = useState(
		initialForms.acpAgents,
	);
	const [umbod, setUmbod] = useState(initialForms.umbod);
	const [autoSleep, setAutoSleep] = useState(initialForms.autoSleep);
	const [projectPreview, setProjectPreview] = useState(
		initialForms.projectPreview,
	);
	const [diagnostics, setDiagnostics] = useState(initialForms.diagnostics);
	const [server, setServer] = useState(initialForms.server);
	const [ui, setUi] = useState(initialForms.ui);
	const [vocab, setVocab] = useState(initialForms.vocab);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [savedMsg, setSavedMsg] = useState<"saved" | "restart" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [warning, setWarning] = useState<string | null>(null);
	const [acpRuntimePending, setAcpRuntimePending] = useState(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);
	const dirtyRef = useRef(false);
	const savingRef = useRef(false);
	const queuedSaveRef = useRef(false);
	const revisionRef = useRef(0);
	const restartRequiredRef = useRef(false);
	const acpRuntimePendingRef = useRef(false);
	const initialRef = useRef(initial);
	const saveRef = useRef<((requiresRestart?: boolean) => Promise<void>) | null>(
		null,
	);
	initialRef.current = initial;
	useEffect(() => {
		if (acpRuntimePendingRef.current) return;
		setPersistedAcpAgents(initial.acp_agents ?? []);
	}, [initial.acp_agents]);
	const currentForms = {
		vault,
		claude,
		codex,
		cliproxy,
		voice,
		server,
		ui,
		vocab,
		acpAgents,
		umbod,
		autoSleep,
		projectPreview,
		diagnostics,
	};
	const currentFormsRef = useRef(currentForms);
	currentFormsRef.current = currentForms;

	async function save(
		requiresRestart = restartRequiredRef.current,
	): Promise<void> {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		if (savingRef.current) {
			queuedSaveRef.current = true;
			return;
		}
		savingRef.current = true;
		setSaving(true);
		setError(null);
		setWarning(null);
		setSavedMsg(null);
		if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
		const revision = revisionRef.current;
		const forms = currentFormsRef.current;
		const config = buildSettingsConfig(
			initialRef.current,
			forms,
			requiresRestart,
		);
		try {
			const response = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const runtimeResult = await responseResult(response);
			if (!mountedRef.current) return;
			publishNavigationNames(forms.ui.navigationNames);
			if (revision === revisionRef.current) {
				dirtyRef.current = false;
				setDirty(false);
			}
			acpRuntimePendingRef.current = !runtimeResult.acpRuntimeSynced;
			setAcpRuntimePending(!runtimeResult.acpRuntimeSynced);
			if (runtimeResult.acpRuntimeSynced) {
				setPersistedAcpAgents(forms.acpAgents);
				setPersistedVaultPath(forms.vault.path);
			}
			setWarning(runtimeResult.warning);
			setSavedMsg(requiresRestart ? "restart" : "saved");
			if (!requiresRestart) {
				savedTimerRef.current = setTimeout(() => setSavedMsg(null), 3000);
			}
			// The configuration write already succeeded. A follow-up route refresh
			// must not turn that into a false save error or encourage a duplicate retry.
			await onSaved().catch(() => {});
		} catch (caught) {
			if (mountedRef.current) {
				dirtyRef.current = true;
				setDirty(true);
				setError(caught instanceof Error ? caught.message : "Save failed");
			}
		} finally {
			savingRef.current = false;
			if (mountedRef.current) setSaving(false);
			if (mountedRef.current && queuedSaveRef.current) {
				queuedSaveRef.current = false;
				void saveRef.current?.(restartRequiredRef.current);
			}
		}
	}
	saveRef.current = save;

	useEffect(() => {
		if (
			vault === initialForms.vault &&
			claude === initialForms.claude &&
			codex === initialForms.codex &&
			cliproxy === initialForms.cliproxy &&
			voice === initialForms.voice &&
			ui === initialForms.ui &&
			vocab === initialForms.vocab &&
			acpAgents === initialForms.acpAgents &&
			umbod === initialForms.umbod &&
			autoSleep === initialForms.autoSleep &&
			projectPreview === initialForms.projectPreview &&
			diagnostics === initialForms.diagnostics &&
			server === initialForms.server
		) {
			return;
		}
		const requiresRestart =
			server !== initialForms.server || umbod !== initialForms.umbod;
		revisionRef.current += 1;
		dirtyRef.current = true;
		restartRequiredRef.current ||= requiresRestart;
		setDirty(true);
		saveTimerRef.current = setTimeout(
			() => void saveRef.current?.(restartRequiredRef.current),
			800,
		);
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		};
	}, [
		vault,
		claude,
		codex,
		cliproxy,
		voice,
		ui,
		vocab,
		acpAgents,
		umbod,
		autoSleep,
		projectPreview,
		diagnostics,
		server,
		initialForms,
	]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
			if (!dirtyRef.current) return;
			const config = buildSettingsConfig(
				initialRef.current,
				currentFormsRef.current,
				restartRequiredRef.current,
			);
			const navigationNames = currentFormsRef.current.ui.navigationNames;
			void fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
				keepalive: true,
			})
				.then((response) => {
					if (response.ok) publishNavigationNames(navigationNames);
				})
				.catch(() => {});
		};
	}, [publishNavigationNames]);

	const changeClaude = (patch: Partial<ClaudeForm>) => {
		const next = applyAgentFormPatch(claude, codex, cliproxy, acpAgents, patch);
		setClaude(next.claude);
		setCodex(next.codex);
		setCliProxy(next.cliproxy);
		setAcpAgents(next.acpAgents);
	};

	return {
		vault,
		persistedVaultPath,
		setVault,
		claude,
		codex,
		cliproxy,
		changeClaude,
		voice,
		setVoice,
		acpAgents,
		persistedAcpAgents,
		setAcpAgents,
		umbod,
		setUmbod,
		autoSleep,
		setAutoSleep,
		projectPreview,
		setProjectPreview,
		diagnostics,
		setDiagnostics,
		server,
		setServer,
		ui,
		setUi,
		vocab,
		setVocab,
		saving,
		dirty,
		savedMsg,
		error,
		warning,
		acpRuntimePending,
		save,
	};
}

export type SettingsFormState = ReturnType<typeof useSettingsForm>;
