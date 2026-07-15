import { Mic, Paperclip, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { AgentSelect } from "#/components/AgentSelect";
import { AttachmentStrip } from "#/components/AttachmentStrip";
import { SlashPicker } from "#/components/cockpit/SlashPicker";
import type { getConfig } from "#/config";
import type { useFileUpload } from "#/hooks/useFileUpload";
import type { useVoiceInput } from "#/hooks/useVoiceInput";
import type { CommandDescriptor } from "#/lib/commands";
import { type ComposerKeyAction, composerKeyAction } from "#/lib/composer";
import type { getAgentListFn } from "#/lib/serverFns/agents";
import { displayVoiceHotkey } from "#/lib/voiceHotkey";

export type ActiveCockpitSkill = CommandDescriptor;

type CockpitConfig = Awaited<ReturnType<typeof getConfig>>;
type AgentList = Awaited<ReturnType<typeof getAgentListFn>>;
type UploadState = ReturnType<typeof useFileUpload>;
type VoiceState = ReturnType<typeof useVoiceInput>;

type PromptProps = {
	config: CockpitConfig;
	prompt: string;
	setPrompt: (value: string) => void;
	activeSkill: ActiveCockpitSkill | null;
	isConnected: boolean;
	isRunning: boolean;
	canRun: boolean;
	selectedAgentPath: string;
	setSelectedAgentPath: (path: string) => void;
	agentList: AgentList;
	background: boolean;
	setBackground: (value: boolean) => void;
	sameSession: boolean;
	setSameSession: (value: boolean) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	fileInputRef: RefObject<HTMLInputElement | null>;
	upload: Pick<
		UploadState,
		| "pendingAttachments"
		| "uploadingCount"
		| "uploadError"
		| "uploadFiles"
		| "removePending"
	>;
	voice: VoiceState;
	picker: {
		open: boolean;
		items: CommandDescriptor[];
		index: number;
		navigate: (direction: 1 | -1) => void;
		close: () => void;
	};
	onSkillSelect: (command: CommandDescriptor) => void;
	onClear: () => void;
	onRun: () => void;
};

function VoiceError({ voice }: { voice: VoiceState }) {
	if (!voice.error) return null;
	return (
		<div
			className="px-3 py-2 flex items-start gap-3 border-b border-destructive/30 bg-destructive/5"
			role="alert"
		>
			<div className="flex-1 text-[10px] text-destructive/80 leading-relaxed">
				voice transcription failed: {voice.error}
			</div>
			<button
				type="button"
				onClick={voice.clearError}
				className="text-destructive/50 hover:text-destructive transition-colors shrink-0"
				aria-label="Dismiss voice error"
			>
				<X className="w-3 h-3" />
			</button>
		</div>
	);
}

function promptPlaceholder(
	voice: VoiceState,
	isConnected: boolean,
	activeSkill: ActiveCockpitSkill | null,
): string {
	if (voice.phase === "recording") return `recording… ${voice.seconds}s`;
	if (voice.phase === "transcribing") return "transcribing locally…";
	if (!isConnected) return "server offline…";
	if (activeSkill) return "add context… (optional)";
	return "type a prompt, or pick a skill below";
}

function runComposerAction(
	action: ComposerKeyAction,
	props: Pick<PromptProps, "picker" | "onSkillSelect" | "onRun">,
): void {
	if (action === "picker-next") props.picker.navigate(1);
	if (action === "picker-previous") props.picker.navigate(-1);
	if (action === "picker-close") props.picker.close();
	if (action === "picker-select" && props.picker.items.length > 0) {
		props.onSkillSelect(props.picker.items[props.picker.index]);
	}
	if (action === "submit") props.onRun();
}

function PromptTextarea(props: PromptProps) {
	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const isTouch =
			typeof window !== "undefined" &&
			window.matchMedia("(pointer: coarse)").matches;
		const action = composerKeyAction({
			key: event.key,
			shiftKey: event.shiftKey,
			metaKey: event.metaKey,
			ctrlKey: event.ctrlKey,
			pickerOpen: props.picker.open,
			isTouch,
			enterToSubmit: props.config.ui.enter_to_submit,
		});
		if (!action) return;
		event.preventDefault();
		runComposerAction(action, props);
	};

	return (
		<div className="flex items-start">
			<span className="text-primary text-sm px-3 py-2.5 shrink-0 select-none">
				›
			</span>
			<textarea
				ref={props.textareaRef}
				value={props.prompt}
				onChange={(event) => props.setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				role="combobox"
				aria-expanded={props.picker.open}
				aria-controls="slash-picker"
				aria-autocomplete="list"
				aria-activedescendant={
					props.picker.open
						? `slash-picker-opt-${props.picker.index}`
						: undefined
				}
				rows={3}
				placeholder={promptPlaceholder(
					props.voice,
					props.isConnected,
					props.activeSkill,
				)}
				disabled={!props.isConnected || props.voice.phase === "transcribing"}
				className={`min-w-0 flex-1 resize-none bg-transparent py-2.5 pr-3 text-sm text-foreground focus:outline-none disabled:opacity-30 overflow-hidden min-h-[72px] ${!props.isConnected ? "placeholder:text-foreground/50" : "placeholder:text-muted-foreground/25"}`}
			/>
		</div>
	);
}

function AgentPicker({
	agents,
	value,
	onChange,
	mobile = false,
}: {
	agents: AgentList;
	value: string;
	onChange: (path: string) => void;
	mobile?: boolean;
}) {
	if (agents.length === 0) return null;
	return (
		<div
			className={
				mobile
					? "md:hidden flex items-baseline gap-2 px-3 py-1.5 border-t border-border/60"
					: "hidden md:flex items-baseline gap-1.5"
			}
		>
			<AgentSelect
				agents={agents}
				value={value}
				onChange={onChange}
				fullWidth={mobile}
			/>
		</div>
	);
}

function VoiceButton({
	config,
	voice,
	isConnected,
}: Pick<PromptProps, "config" | "voice" | "isConnected">) {
	const recording = voice.phase === "recording";
	const title = !config.voice.enabled
		? "Enable voice in Forge"
		: voice.status.state !== "ready"
			? `Voice ${voice.status.state}`
			: config.voice.hotkey
				? `Voice input (${displayVoiceHotkey(config.voice.hotkey)})`
				: "Start voice input";
	return (
		<>
			<button
				type="button"
				onClick={() => (recording ? voice.stop() : void voice.start())}
				onFocus={voice.refresh}
				disabled={
					!isConnected ||
					(!voice.ready && !recording) ||
					voice.phase === "transcribing"
				}
				className={`transition-colors shrink-0 disabled:opacity-30 ${recording ? "text-destructive" : "text-muted-foreground/45 hover:text-muted-foreground"}`}
				aria-label={recording ? "Stop recording" : "Start voice input"}
				title={title}
			>
				{recording ? (
					<Square className="w-3.5 h-3.5 fill-current" />
				) : (
					<Mic className="w-3.5 h-3.5" />
				)}
			</button>
			{recording && (
				<button
					type="button"
					onClick={voice.cancel}
					className="text-muted-foreground/45 hover:text-muted-foreground"
					aria-label="Cancel recording"
					title="Cancel recording"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</>
	);
}

function ComposerToggle({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-1.5 cursor-pointer select-none group">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="sr-only"
			/>
			<span
				className={`w-3 h-3 border flex items-center justify-center shrink-0 transition-colors ${checked ? "border-primary bg-primary/20" : "border-border bg-secondary group-hover:border-primary/40"}`}
			>
				{checked && <span className="w-1.5 h-1.5 bg-primary block" />}
			</span>
			<span className="text-[9px] tracking-wider text-muted-foreground/40 uppercase">
				{label}
			</span>
		</label>
	);
}

function ComposerToolbar(props: PromptProps) {
	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 border-t border-border/60">
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
				<input
					ref={props.fileInputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(event) => {
						if (event.target.files)
							void props.upload.uploadFiles(event.target.files);
						event.target.value = "";
					}}
				/>
				<button
					type="button"
					onClick={() => props.fileInputRef.current?.click()}
					disabled={!props.isConnected}
					className="text-muted-foreground/45 hover:text-muted-foreground transition-colors shrink-0 disabled:opacity-30"
					aria-label="Attach file"
					title="Attach file"
				>
					<Paperclip className="w-3.5 h-3.5" />
				</button>
				<VoiceButton {...props} />
				<AgentPicker
					agents={props.agentList}
					value={props.selectedAgentPath}
					onChange={props.setSelectedAgentPath}
				/>
				<ComposerToggle
					label="Background"
					checked={props.background}
					onChange={props.setBackground}
				/>
				<ComposerToggle
					label="Same Session"
					checked={props.sameSession}
					onChange={props.setSameSession}
				/>
			</div>
			<div className="ml-auto flex shrink-0 gap-2">
				{(props.prompt || props.activeSkill) && (
					<button
						type="button"
						onClick={props.onClear}
						className="px-3 py-1 border border-border text-[10px] tracking-widest text-muted-foreground/50 hover:text-foreground hover:border-border/80 transition-colors uppercase"
					>
						CLEAR
					</button>
				)}
				<button
					type="button"
					onClick={props.onRun}
					disabled={!props.canRun}
					className="px-3 py-1 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-25 uppercase"
				>
					{props.isRunning ? "QUEUE →" : "RUN →"}
				</button>
			</div>
		</div>
	);
}

export function CockpitPrompt(props: PromptProps) {
	const onDragOver = (event: React.DragEvent<HTMLElement>) => {
		if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
	};
	const onDrop = (event: React.DragEvent<HTMLElement>) => {
		if (!event.dataTransfer?.files?.length) return;
		event.preventDefault();
		void props.upload.uploadFiles(event.dataTransfer.files);
	};
	return (
		<div className="min-w-0 p-4 border-b border-border space-y-2 shrink-0">
			<div className="flex items-center justify-between mb-1">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					PROMPT
					{props.activeSkill && (
						<span className="text-primary/50 ml-2">
							· {props.activeSkill.name}
						</span>
					)}
				</div>
			</div>
			<section
				aria-label="Prompt input area"
				className={`relative min-w-0 border bg-card transition-colors ${props.isConnected ? "border-border focus-within:border-primary/30" : "border-border/40"}`}
				onDragOver={onDragOver}
				onDrop={onDrop}
			>
				{props.picker.open && (
					<SlashPicker
						items={props.picker.items}
						selectedIndex={props.picker.index}
						onSelect={props.onSkillSelect}
					/>
				)}
				<AttachmentStrip
					attachments={props.upload.pendingAttachments}
					uploadingCount={props.upload.uploadingCount}
					uploadError={props.upload.uploadError}
					onRemove={props.upload.removePending}
					className="px-3 py-2"
				/>
				<VoiceError voice={props.voice} />
				<PromptTextarea {...props} />
				<AgentPicker
					agents={props.agentList}
					value={props.selectedAgentPath}
					onChange={props.setSelectedAgentPath}
					mobile
				/>
				<ComposerToolbar {...props} />
			</section>
		</div>
	);
}
