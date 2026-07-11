import { useState } from "react";
import { AcpSection } from "#/components/forge/AcpSection";
import { ApiSection } from "#/components/forge/ApiSection";
import { ClaudeSection } from "#/components/forge/ClaudeSection";
import { EventLogSection } from "#/components/forge/EventLogSection";
import { McpSection } from "#/components/forge/McpSection";
import { NetworkSection } from "#/components/forge/NetworkSection";
import { SecuritySection } from "#/components/forge/SecuritySection";
import { SessionSection } from "#/components/forge/SessionSection";
import { SystemSection } from "#/components/forge/SystemSection";
import { UiSection } from "#/components/forge/UiSection";
import { UpdatesSection } from "#/components/forge/UpdatesSection";
import { VaultSection } from "#/components/forge/VaultSection";
import { VocabSection } from "#/components/forge/VocabSection";
import { VoiceSection } from "#/components/forge/VoiceSection";
import type {
	SettingsFormState,
	SettingsInitial,
} from "#/hooks/useSettingsForm";

const TABS = [
	"general",
	"network",
	"security",
	"vault",
	"agent",
	"voice",
	"interface",
	"logs",
	"api",
] as const;
type Tab = (typeof TABS)[number];

function TabNavigation({
	tab,
	onChange,
}: {
	tab: Tab;
	onChange: (tab: Tab) => void;
}) {
	return (
		<div className="flex flex-wrap border-b border-border shrink-0">
			{TABS.map((item) => (
				<button
					key={item}
					type="button"
					onClick={() => onChange(item)}
					aria-pressed={tab === item}
					className={`px-5 py-2.5 text-[10px] tracking-widest uppercase transition-colors border-b-2 -mb-px ${tab === item ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
				>
					{item}
				</button>
			))}
		</div>
	);
}

function AgentSettings({
	state,
	initial,
}: {
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	const agentForm =
		state.claude.vaultProvider === "codex"
			? {
					...state.codex,
					vaultProvider: state.claude.vaultProvider,
					interactiveMode: state.claude.interactiveMode,
				}
			: state.claude;
	return (
		<>
			<ClaudeSection
				claude={agentForm}
				onChange={state.changeClaude}
				providers={initial.providers}
				accountInfo={initial.accountInfo}
			/>
			<AcpSection
				initialCatalog={initial.acpCatalog}
				value={state.acpAgents}
				onChange={state.setAcpAgents}
			/>
		</>
	);
}

function SettingsTabContent({
	tab,
	state,
	initial,
}: {
	tab: Tab;
	state: SettingsFormState;
	initial: SettingsInitial;
}) {
	switch (tab) {
		case "general":
			return (
				<>
					<UpdatesSection />
					<SystemSection />
					<SessionSection />
				</>
			);
		case "network":
			return (
				<NetworkSection
					server={state.server}
					onChange={(patch) =>
						state.setServer((server) => ({ ...server, ...patch }))
					}
					cwd={initial.cwd}
				/>
			);
		case "security":
			return <SecuritySection />;
		case "vault":
			return (
				<>
					<VaultSection
						vault={state.vault}
						onChange={(patch) =>
							state.setVault((vault) => ({ ...vault, ...patch }))
						}
					/>
					<VocabSection
						vocab={state.vocab}
						onChange={(patch) =>
							state.setVocab((vocab) => ({ ...vocab, ...patch }))
						}
					/>
					<McpSection vaultPath={state.vault.path} />
				</>
			);
		case "agent":
			return <AgentSettings state={state} initial={initial} />;
		case "voice":
			return (
				<VoiceSection
					voice={state.voice}
					onChange={(patch) =>
						state.setVoice((voice) => ({ ...voice, ...patch }))
					}
					initialInfo={initial.voiceInfo}
				/>
			);
		case "interface":
			return (
				<UiSection
					ui={state.ui}
					onChange={(patch) => state.setUi((ui) => ({ ...ui, ...patch }))}
				/>
			);
		case "logs":
			return <EventLogSection />;
		case "api":
			return <ApiSection />;
	}
}

function SaveBar({
	state,
	showButton,
}: {
	state: SettingsFormState;
	showButton: boolean;
}) {
	const show = showButton || state.savedMsg !== null || state.error !== null;
	if (!show) return null;
	return (
		<div className="shrink-0 border-t border-border bg-background/95 px-5 py-3 flex items-center justify-between gap-4">
			<div className="text-xs tracking-wider">
				{state.error && <span className="text-destructive">{state.error}</span>}
				{state.savedMsg === "saved" && (
					<span className="text-green-500">Changes saved.</span>
				)}
				{state.savedMsg === "restart" && (
					<span className="text-green-500">
						Changes saved. Restart required.
					</span>
				)}
			</div>
			{showButton && (
				<button
					type="button"
					onClick={() => void state.save(true)}
					disabled={state.saving}
					className="px-4 py-2 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 uppercase"
				>
					{state.saving ? "SAVING…" : "SAVE CHANGES"}
				</button>
			)}
		</div>
	);
}

export function ForgeSettings({
	initial,
	state,
}: {
	initial: SettingsInitial;
	state: SettingsFormState;
}) {
	const [tab, setTab] = useState<Tab>("general");
	const showSaveButton = tab === "network";
	const showSaveBar =
		showSaveButton ||
		(tab !== "logs" &&
			tab !== "general" &&
			(state.savedMsg !== null || state.error !== null));
	return (
		<div className="flex flex-col h-full">
			<TabNavigation tab={tab} onChange={setTab} />
			<div className="flex-1 overflow-auto p-5 space-y-6">
				<SettingsTabContent tab={tab} state={state} initial={initial} />
			</div>
			{showSaveBar && <SaveBar state={state} showButton={showSaveButton} />}
		</div>
	);
}
