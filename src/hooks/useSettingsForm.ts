import { useEffect, useRef, useState } from "react";
import type { ClaudeForm } from "#/components/forge/ClaudeSection";
import type { HlidConfig } from "#/config";
import type { getAcpRegistryFn } from "#/lib/serverFns/acp";
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

export function useSettingsForm(
	initial: SettingsInitial,
	onSaved: () => Promise<void>,
) {
	const initialFormsRef = useRef(createSettingsForms(initial));
	const initialForms = initialFormsRef.current;
	const [vault, setVault] = useState(initialForms.vault);
	const [claude, setClaude] = useState(initialForms.claude);
	const [codex, setCodex] = useState(initialForms.codex);
	const [voice, setVoice] = useState(initialForms.voice);
	const [acpAgents, setAcpAgents] = useState(initialForms.acpAgents);
	const [umbod, setUmbod] = useState(initialForms.umbod);
	const [autoSleep, setAutoSleep] = useState(initialForms.autoSleep);
	const [server, setServer] = useState(initialForms.server);
	const [ui, setUi] = useState(initialForms.ui);
	const [vocab, setVocab] = useState(initialForms.vocab);
	const [saving, setSaving] = useState(false);
	const [savedMsg, setSavedMsg] = useState<"saved" | "restart" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const saveRef = useRef<((requiresRestart?: boolean) => Promise<void>) | null>(
		null,
	);

	async function save(requiresRestart = false) {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		setSaving(true);
		setError(null);
		setSavedMsg(null);
		const config = buildSettingsConfig(
			initial,
			{
				vault,
				claude,
				codex,
				voice,
				server,
				ui,
				vocab,
				acpAgents,
				umbod,
				autoSleep,
			},
			requiresRestart,
		);
		try {
			const response = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			if (!response.ok) throw new Error(await responseError(response));
			setSavedMsg(requiresRestart ? "restart" : "saved");
			setTimeout(() => setSavedMsg(null), 3000);
			await onSaved();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}
	saveRef.current = save;

	useEffect(() => {
		if (
			vault === initialForms.vault &&
			claude === initialForms.claude &&
			codex === initialForms.codex &&
			voice === initialForms.voice &&
			ui === initialForms.ui &&
			vocab === initialForms.vocab &&
			acpAgents === initialForms.acpAgents &&
			umbod === initialForms.umbod &&
			autoSleep === initialForms.autoSleep &&
			server === initialForms.server
		) {
			return;
		}
		const requiresRestart =
			server !== initialForms.server ||
			acpAgents !== initialForms.acpAgents ||
			umbod !== initialForms.umbod;
		saveTimerRef.current = setTimeout(
			() => void saveRef.current?.(requiresRestart),
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
		voice,
		ui,
		vocab,
		acpAgents,
		umbod,
		autoSleep,
		server,
		initialForms,
	]);

	const changeClaude = (patch: Partial<ClaudeForm>) => {
		const next = applyAgentFormPatch(claude, codex, patch);
		setClaude(next.claude);
		setCodex(next.codex);
	};

	return {
		vault,
		setVault,
		claude,
		codex,
		changeClaude,
		voice,
		setVoice,
		acpAgents,
		setAcpAgents,
		umbod,
		setUmbod,
		autoSleep,
		setAutoSleep,
		server,
		setServer,
		ui,
		setUi,
		vocab,
		setVocab,
		saving,
		savedMsg,
		error,
		save,
	};
}

export type SettingsFormState = ReturnType<typeof useSettingsForm>;
