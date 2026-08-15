import { Bell, LoaderCircle } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "#/hooks/useAnchoredPopover";
import type { PendingSessionNotificationPolicy } from "#/lib/pendingSessionNotificationPolicy";
import {
	getPushNotificationDevices,
	getSessionNotificationOverride,
	type PushNotificationDevice,
	type SessionNotificationOverride,
	type SessionNotificationPolicyState,
	type SessionNotificationPolicyUpdate,
	setSessionNotificationOverride,
} from "#/lib/pushNotifications";

type SaveProvisionalSessionNotificationPolicy = (
	policy: PendingSessionNotificationPolicy | null,
) => void | Promise<void>;

type SessionNotificationOverrideTargetProps = {
	sessionId: string;
	/** Undefined uses the persisted session API; null is provisional Default. */
	provisionalPolicy?: PendingSessionNotificationPolicy | null;
	onSaveProvisionalPolicy?: SaveProvisionalSessionNotificationPolicy;
};

export type SessionNotificationOverrideButtonProps =
	SessionNotificationOverrideTargetProps & {
		disabled?: boolean;
		trackingRef?: RefObject<HTMLElement | null>;
	};

export type SessionNotificationOverrideControlProps =
	SessionNotificationOverrideTargetProps & {
		onSaveSuccess?: () => void;
	};

const OPTIONS = [
	{
		value: "default",
		label: "Default",
		description: "Use the effective notification rules for this session.",
	},
	{
		value: "notify_completion_once",
		label: "Notify when finished",
		description:
			"Notify once when this session finishes, then return to Default.",
	},
	{
		value: "notify",
		label: "Always notify",
		description: "Send every eligible alert until this is changed.",
	},
	{
		value: "mute",
		label: "Mute",
		description: "Do not send alerts covered by this setting.",
	},
] as const satisfies ReadonlyArray<{
	value: SessionNotificationOverride;
	label: string;
	description: string;
}>;

const LEGACY_NOTIFY_ONCE_OPTION = {
	value: "notify_once",
	label: "Next alert once (legacy)",
	description: "Notify for the next eligible alert, then return to Default.",
} as const satisfies {
	value: SessionNotificationOverride;
	label: string;
	description: string;
};

function draftFromState(
	state: SessionNotificationPolicyState,
): SessionNotificationPolicyUpdate {
	return {
		mode: state.policy?.mode ?? "default",
		scope: state.policy?.scope ?? "session",
		targetDeviceIds: state.policy?.targetDeviceIds ?? null,
	};
}

function stateFromPendingPolicy(
	policy: PendingSessionNotificationPolicy | null,
): SessionNotificationPolicyState {
	return {
		policy:
			policy === null
				? null
				: {
						sessionId: "pending",
						...policy,
						updatedAt: 0,
					},
		effective: {
			requestedSessionId: "pending",
			sourceSessionId: policy === null ? null : "pending",
			mode: policy?.mode ?? "default",
			scope: policy?.scope ?? "session",
			targetDeviceIds: policy?.targetDeviceIds ?? null,
			inherited: false,
		},
	};
}

function pendingPolicyFromDraft(
	draft: SessionNotificationPolicyUpdate,
): PendingSessionNotificationPolicy | null {
	if (draft.mode === "default") return null;
	return draft as PendingSessionNotificationPolicy;
}

function comparableDraft(draft: SessionNotificationPolicyUpdate): string {
	if (draft.mode === "default") return "default";
	return JSON.stringify({
		...draft,
		targetDeviceIds:
			draft.targetDeviceIds === null ? null : [...draft.targetDeviceIds].sort(),
	});
}

function modeLabel(mode: SessionNotificationOverride): string {
	switch (mode) {
		case "default":
			return "Default device rules";
		case "notify_completion_once":
			return "Notify when finished once";
		case "notify_once":
			return "Next eligible alert once";
		case "notify":
			return "Always notify";
		case "mute":
			return "Muted";
	}
}

function targetLabel(
	targetDeviceIds: string[] | null,
	devices: PushNotificationDevice[],
): string {
	if (targetDeviceIds === null) return "all subscribed devices";
	if (targetDeviceIds.length === 0) return "no devices";
	const names = targetDeviceIds.map(
		(id) => devices.find((device) => device.id === id)?.name ?? id,
	);
	if (names.length <= 2) return names.join(" and ");
	return `${names.length} exact devices`;
}

function EffectivePolicy({
	state,
	devices,
}: {
	state: SessionNotificationPolicyState;
	devices: PushNotificationDevice[];
}) {
	const { effective } = state;
	return (
		<output
			aria-label="Effective notification policy"
			aria-live="polite"
			className="mx-1.5 block border border-border/60 bg-secondary/20 px-2 py-1.5 normal-case tracking-normal"
		>
			<div className="text-[9px] text-foreground/75">
				Effective: {modeLabel(effective.mode)}
			</div>
			<div className="mt-0.5 text-[8px] leading-tight text-muted-foreground/55">
				{effective.scope === "delegation_tree"
					? "This session and its delegated sessions"
					: "This session only"}
				{" · "}
				{targetLabel(effective.targetDeviceIds, devices)}
			</div>
			{effective.inherited && effective.sourceSessionId && (
				<div className="mt-1 break-all text-[8px] leading-tight text-muted-foreground/70">
					Inherited from parent session {effective.sourceSessionId}.
				</div>
			)}
		</output>
	);
}

export function SessionNotificationOverrideButton(
	props: SessionNotificationOverrideButtonProps,
) {
	const { disabled = false, trackingRef } = props;
	const { sessionId, provisionalPolicy, onSaveProvisionalPolicy } = props;
	const [open, setOpen] = useState(false);
	const dialogId = useId();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const targetKey =
		provisionalPolicy === undefined
			? `session:${sessionId}`
			: `pending:${sessionId}`;
	const previousTargetKeyRef = useRef(targetKey);
	const focusedForOpenRef = useRef(false);
	const position = useAnchoredPopover(
		open,
		buttonRef,
		320,
		480,
		dialogRef,
		trackingRef,
	);

	useEffect(() => {
		if (previousTargetKeyRef.current === targetKey) return;
		previousTargetKeyRef.current = targetKey;
		setOpen(false);
	}, [targetKey]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useEffect(() => {
		if (!open) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!buttonRef.current?.contains(event.target) &&
				!dialogRef.current?.contains(event.target)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
		};
	}, [open]);

	useEffect(() => {
		if (!open) {
			focusedForOpenRef.current = false;
			return;
		}
		if (!position || focusedForOpenRef.current) return;
		focusedForOpenRef.current = true;
		dialogRef.current?.focus();
	}, [open, position]);

	return (
		<div className="relative shrink-0">
			<button
				ref={buttonRef}
				type="button"
				disabled={disabled}
				aria-label="Session notifications"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? dialogId : undefined}
				title={
					disabled
						? "The notification setting is being saved with this chat"
						: "Session notification settings"
				}
				onClick={() => setOpen((value) => !value)}
				className={`shrink-0 px-2 py-2 transition-colors disabled:cursor-wait disabled:opacity-35 md:py-3 ${
					open
						? "text-primary"
						: "text-muted-foreground/45 hover:text-muted-foreground"
				}`}
			>
				<Bell aria-hidden className="h-3.5 w-3.5" />
			</button>
			{open &&
				position &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						id={dialogId}
						ref={dialogRef}
						tabIndex={-1}
						role="dialog"
						aria-label="Session notification settings"
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.stopPropagation();
							setOpen(false);
							buttonRef.current?.focus();
						}}
						className="fixed z-[70] touch-pan-y overflow-y-auto overscroll-contain border border-border bg-popover px-3 py-2 text-[9px] tracking-widest uppercase shadow-xl focus:outline-none"
						style={{
							left: position.left,
							top: position.top,
							width: position.width,
							maxHeight: position.maxHeight,
						}}
					>
						<SessionNotificationOverrideControl
							sessionId={sessionId}
							provisionalPolicy={provisionalPolicy}
							onSaveProvisionalPolicy={onSaveProvisionalPolicy}
							onSaveSuccess={() => {
								setOpen(false);
								buttonRef.current?.focus();
							}}
						/>
					</div>,
					document.body,
				)}
		</div>
	);
}

export function SessionNotificationOverrideControl(
	props: SessionNotificationOverrideControlProps,
) {
	const { onSaveSuccess } = props;
	const { sessionId, provisionalPolicy, onSaveProvisionalPolicy } = props;
	const persistedSessionId = provisionalPolicy === undefined ? sessionId : null;
	const provisionalSessionId =
		provisionalPolicy === undefined ? null : sessionId;
	const targetRef = useRef<
		| { kind: "persisted" }
		| {
				kind: "provisional";
				policy: PendingSessionNotificationPolicy | null;
				onSave: SaveProvisionalSessionNotificationPolicy | undefined;
		  }
	>(
		provisionalPolicy === undefined
			? { kind: "persisted" }
			: {
					kind: "provisional",
					policy: provisionalPolicy,
					onSave: onSaveProvisionalPolicy,
				},
	);
	targetRef.current =
		provisionalPolicy === undefined
			? { kind: "persisted" }
			: {
					kind: "provisional",
					policy: provisionalPolicy,
					onSave: onSaveProvisionalPolicy,
				};
	const [state, setState] = useState<SessionNotificationPolicyState | null>(
		() =>
			provisionalPolicy === undefined
				? null
				: stateFromPendingPolicy(provisionalPolicy),
	);
	const [draft, setDraft] = useState<SessionNotificationPolicyUpdate | null>(
		() =>
			provisionalPolicy === undefined
				? null
				: draftFromState(stateFromPendingPolicy(provisionalPolicy)),
	);
	const [devices, setDevices] = useState<PushNotificationDevice[]>([]);
	const [devicesLoading, setDevicesLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deviceError, setDeviceError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const target = targetRef.current;
		if (persistedSessionId !== null) {
			setState(null);
			setDraft(null);
			void getSessionNotificationOverride(persistedSessionId).then(
				(value) => {
					if (cancelled) return;
					setState(value);
					setDraft(draftFromState(value));
				},
				(cause) => {
					if (!cancelled) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not load the session notification setting.",
						);
					}
				},
			);
		} else if (provisionalSessionId !== null && target.kind === "provisional") {
			const next = stateFromPendingPolicy(target.policy);
			setState(next);
			setDraft(draftFromState(next));
		}
		setDevices([]);
		setDevicesLoading(true);
		setError(null);
		setDeviceError(null);
		void getPushNotificationDevices()
			.then((value) => {
				if (!cancelled) setDevices(value);
			})
			.catch((cause) => {
				if (!cancelled) {
					setDeviceError(
						cause instanceof Error
							? cause.message
							: "Could not load notification devices.",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setDevicesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [persistedSessionId, provisionalSessionId]);

	async function save() {
		if (saving || !state || !draft) return;
		const previous = draftFromState(state);
		const update: SessionNotificationPolicyUpdate =
			draft.mode === "default"
				? { mode: "default", scope: "session", targetDeviceIds: null }
				: draft;
		setSaving(true);
		setError(null);
		let saved = false;
		try {
			const target = targetRef.current;
			let next: SessionNotificationPolicyState;
			if (target.kind === "persisted") {
				next = await setSessionNotificationOverride(sessionId, update);
			} else {
				const nextPolicy = pendingPolicyFromDraft(update);
				if (!target.onSave) {
					throw new Error("Could not save the pending notification setting.");
				}
				await target.onSave(nextPolicy);
				next = stateFromPendingPolicy(nextPolicy);
			}
			setState(next);
			setDraft(draftFromState(next));
			saved = true;
		} catch (cause) {
			setDraft(previous);
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save the session notification setting.",
			);
		} finally {
			setSaving(false);
		}
		if (saved) onSaveSuccess?.();
	}

	const options =
		draft?.mode === "notify_once"
			? [...OPTIONS, LEGACY_NOTIFY_ONCE_OPTION]
			: OPTIONS;
	const targetIds = draft?.targetDeviceIds ?? null;
	const missingTargetIds =
		targetIds?.filter((id) => !devices.some((device) => device.id === id)) ??
		[];
	const validTargets =
		draft?.mode === "default" || targetIds === null || targetIds.length > 0;
	const dirty =
		state !== null &&
		draft !== null &&
		comparableDraft(draft) !== comparableDraft(draftFromState(state));

	return (
		<div className="space-y-1 border-t border-border/50 pt-1">
			<div className="text-muted-foreground/40">notifications</div>
			{state === null || draft === null ? (
				!error && (
					<output
						aria-label="Loading session notification setting"
						className="flex items-center gap-1.5 px-1.5 py-1 normal-case tracking-normal text-muted-foreground/60"
					>
						<LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
						Loading…
					</output>
				)
			) : (
				<>
					<EffectivePolicy state={state} devices={devices} />
					<fieldset disabled={saving} className="space-y-0.5">
						<legend className="sr-only">Session notification mode</legend>
						{options.map((option) => (
							<button
								key={option.value}
								type="button"
								aria-label={option.label}
								aria-pressed={draft.mode === option.value}
								onClick={() =>
									setDraft((current) =>
										current ? { ...current, mode: option.value } : current,
									)
								}
								className={`block min-h-11 w-full px-1.5 py-1 text-left normal-case tracking-normal transition-colors disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0 ${
									draft.mode === option.value
										? "bg-primary/10 text-primary"
										: "text-foreground/70 hover:bg-accent"
								}`}
							>
								<span>{option.label}</span>
								<span className="mt-0.5 block text-[8px] leading-tight text-muted-foreground/45">
									{option.description}
								</span>
							</button>
						))}
					</fieldset>
					{draft.mode !== "default" && (
						<div className="space-y-2 border-t border-border/40 px-1.5 pt-2 normal-case tracking-normal">
							<label className="block text-[8px] text-muted-foreground/60">
								Scope
								<select
									aria-label="Notification scope"
									disabled={saving}
									value={draft.scope}
									onChange={(event) =>
										setDraft((current) =>
											current
												? {
														...current,
														scope: event.target.value as
															| "session"
															| "delegation_tree",
													}
												: current,
										)
									}
									className="mt-1 min-h-11 w-full border border-border bg-input px-2 py-1 text-[9px] text-foreground lg:min-h-0"
								>
									<option value="session">This session</option>
									<option value="delegation_tree">
										This session and delegated sessions
									</option>
								</select>
							</label>
							<label className="block text-[8px] text-muted-foreground/60">
								Devices
								<select
									aria-label="Notification devices"
									disabled={saving}
									value={targetIds === null ? "all" : "exact"}
									onChange={(event) =>
										setDraft((current) =>
											current
												? {
														...current,
														targetDeviceIds:
															event.target.value === "all" ? null : [],
													}
												: current,
										)
									}
									className="mt-1 min-h-11 w-full border border-border bg-input px-2 py-1 text-[9px] text-foreground lg:min-h-0"
								>
									<option value="all">All subscribed devices</option>
									<option value="exact">Specific devices</option>
								</select>
							</label>
							{targetIds !== null && (
								<fieldset className="space-y-1 border border-border/50 p-1.5">
									<legend className="sr-only">
										Exact notification devices
									</legend>
									{devicesLoading && (
										<div className="flex items-center gap-1 text-[8px] text-muted-foreground/50">
											<LoaderCircle
												aria-hidden
												className="h-2.5 w-2.5 animate-spin"
											/>
											Loading devices…
										</div>
									)}
									{!devicesLoading && devices.length === 0 && (
										<div className="text-[8px] text-muted-foreground/55">
											No subscribed devices. Add one in Forge.
										</div>
									)}
									{devices.map((device) => (
										<label
											key={device.id}
											title={device.id}
											className="flex min-h-11 items-center gap-1.5 text-[8px] text-foreground/70 lg:min-h-0"
										>
											<input
												type="checkbox"
												disabled={saving}
												checked={targetIds.includes(device.id)}
												onChange={(event) =>
													setDraft((current) => {
														if (!current || current.targetDeviceIds === null)
															return current;
														const next = event.target.checked
															? [...current.targetDeviceIds, device.id]
															: current.targetDeviceIds.filter(
																	(id) => id !== device.id,
																);
														return { ...current, targetDeviceIds: next };
													})
												}
											/>
											<span>
												{device.name}
												{device.current ? " (this device)" : ""}
												{!device.enabled ? " · disabled" : ""}
											</span>
										</label>
									))}
									{missingTargetIds.map((id) => (
										<label
											key={id}
											className="flex min-h-11 items-center gap-1.5 text-[8px] text-muted-foreground/60 lg:min-h-0"
										>
											<input
												type="checkbox"
												disabled={saving}
												checked
												onChange={() =>
													setDraft((current) =>
														current?.targetDeviceIds
															? {
																	...current,
																	targetDeviceIds:
																		current.targetDeviceIds.filter(
																			(candidate) => candidate !== id,
																		),
																}
															: current,
													)
												}
											/>
											<span className="break-all">Unavailable device {id}</span>
										</label>
									))}
								</fieldset>
							)}
							{!validTargets && (
								<div role="alert" className="text-[8px] text-destructive/80">
									Choose at least one exact notification device.
								</div>
							)}
						</div>
					)}
					<div className="flex items-center justify-between gap-2 border-t border-border/40 px-1.5 pt-1.5 normal-case tracking-normal">
						<span className="text-[8px] text-muted-foreground/35">
							{provisionalPolicy === undefined
								? "Stored with this session"
								: "Will apply when this chat starts"}
						</span>
						<button
							type="button"
							disabled={saving || !dirty || !validTargets}
							onClick={() => void save()}
							className="flex min-h-11 items-center gap-1 border border-border px-2 py-1 text-[9px] text-foreground/80 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
						>
							{saving && (
								<LoaderCircle
									aria-hidden
									className="h-2.5 w-2.5 animate-spin"
								/>
							)}
							Save
						</button>
					</div>
				</>
			)}
			{error && (
				<div
					role="alert"
					className="px-1.5 py-1 normal-case tracking-normal text-destructive/80"
				>
					{error}
				</div>
			)}
			{deviceError && (
				<div className="px-1.5 py-1 normal-case tracking-normal text-muted-foreground/50">
					Could not list devices: {deviceError}
				</div>
			)}
		</div>
	);
}
