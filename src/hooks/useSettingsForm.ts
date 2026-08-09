import { useEffect, useRef, useState } from "react";
import type { ClaudeForm } from "#/components/forge/ClaudeSection";
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

async function responseWarning(response: Response): Promise<string | null> {
	try {
		const body = (await response.json()) as { warning?: unknown };
		return typeof body.warning === "string" && body.warning.trim()
			? body.warning.trim()
			: null;
	} catch {
		return null;
	}
}

function acpRuntimeIdentity(
	agents: NonNullable<HlidConfig["acp_agents"]>,
): string {
	return JSON.stringify(
		agents
			.map((agent) => ({
				id: agent.id,
				executable: agent.executable,
				args: agent.args,
				env: agent.env
					? Object.fromEntries(
							Object.entries(agent.env).sort(([a], [b]) => a.localeCompare(b)),
						)
					: undefined,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
	);
}

export function useSettingsForm(
	initial: SettingsInitial,
	onSaved: () => Promise<void>,
) {
	const initialFormsRef = useRef(createSettingsForms(initial));
	const initialForms = initialFormsRef.current;
	const [vault, setVault] = useState(initialForms.vault);
	const [claude, setClaude] = useState(initialForms.claude);
	const [codex, setCodex] = useState(initialForms.codex);
	const [cliproxy, setCliProxy] = useState(initialForms.cliproxy);
	const [voice, setVoice] = useState(initialForms.voice);
	const [acpAgents, setAcpAgents] = useState(initialForms.acpAgents);
	const [umbod, setUmbod] = useState(initialForms.umbod);
	const [autoSleep, setAutoSleep] = useState(initialForms.autoSleep);
	const [projectPreview, setProjectPreview] = useState(
		initialForms.projectPreview,
	);
	const [server, setServer] = useState(initialForms.server);
	const [ui, setUi] = useState(initialForms.ui);
	const [vocab, setVocab] = useState(initialForms.vocab);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [savedMsg, setSavedMsg] = useState<"saved" | "restart" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [warning, setWarning] = useState<string | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);
	const dirtyRef = useRef(false);
	const savingRef = useRef(false);
	const queuedSaveRef = useRef(false);
	const revisionRef = useRef(0);
	const restartRequiredRef = useRef(false);
	const initialRef = useRef(initial);
	const saveRef = useRef<((requiresRestart?: boolean) => Promise<void>) | null>(
		null,
	);
	initialRef.current = initial;
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
			const runtimeWarning = await responseWarning(response);
			if (!mountedRef.current) return;
			if (revision === revisionRef.current) {
				dirtyRef.current = false;
				setDirty(false);
			}
			setWarning(runtimeWarning);
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
			server === initialForms.server
		) {
			return;
		}
		const requiresRestart =
			server !== initialForms.server ||
			acpRuntimeIdentity(acpAgents) !==
				acpRuntimeIdentity(initialForms.acpAgents) ||
			umbod !== initialForms.umbod;
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
		server,
		initialForms,
	]);

	useEffect(
		() => () => {
			mountedRef.current = false;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
			if (!dirtyRef.current) return;
			const config = buildSettingsConfig(
				initialRef.current,
				currentFormsRef.current,
				restartRequiredRef.current,
			);
			void fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
				keepalive: true,
			}).catch(() => {});
		},
		[],
	);

	const changeClaude = (patch: Partial<ClaudeForm>) => {
		const next = applyAgentFormPatch(claude, codex, cliproxy, acpAgents, patch);
		setClaude(next.claude);
		setCodex(next.codex);
		setCliProxy(next.cliproxy);
		setAcpAgents(next.acpAgents);
	};

	return {
		vault,
		setVault,
		claude,
		codex,
		cliproxy,
		changeClaude,
		voice,
		setVoice,
		acpAgents,
		setAcpAgents,
		umbod,
		setUmbod,
		autoSleep,
		setAutoSleep,
		projectPreview,
		setProjectPreview,
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
		save,
	};
}

export type SettingsFormState = ReturnType<typeof useSettingsForm>;
