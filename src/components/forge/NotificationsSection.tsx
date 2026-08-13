import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	disablePushNotifications,
	enablePushNotifications,
	getPushNotificationState,
	getPushNotificationSupport,
	type PushNotificationPreferences,
	type PushNotificationState,
	type PushNotificationSupport,
	type PushNotificationUnsupportedReason,
	updatePushNotificationPreferences,
} from "#/lib/pushNotifications";
import { Field, Section } from "./fields";

function failureMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

function permissionLabel(state: PushNotificationState): string {
	if (state.permission === "denied") return "Blocked by this browser";
	if (state.permission === "default") return "Not requested";
	if (state.permission === "unsupported") return "Unavailable";
	return state.enabled ? "Allowed and enabled" : "Allowed, but not enabled";
}

function unsupportedReasonLabel(
	reason: PushNotificationUnsupportedReason | undefined,
): string {
	switch (reason) {
		case "insecure-context":
			return "Open Hlid over HTTPS to use background notifications.";
		case "notifications-unavailable":
			return "This browser does not provide notification permission.";
		case "service-worker-unavailable":
			return "This browser context cannot run Hlid's background service worker.";
		case "push-unavailable":
			return "This browser does not support Web Push.";
		case "server-unavailable":
			return "Push delivery is not configured on this Hlid server.";
		case "not-browser":
		case undefined:
			return "This browser or app context does not support background notifications.";
	}
}

function NotificationToggle({
	checked,
	disabled,
	label,
	name,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	name: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-center gap-2">
			<input
				type="checkbox"
				aria-label={name}
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
				className="h-3.5 w-3.5 accent-primary disabled:cursor-not-allowed"
			/>
			<span className="text-xs text-muted-foreground">{label}</span>
		</label>
	);
}

export function NotificationsSection() {
	const [support, setSupport] = useState<PushNotificationSupport | null>(null);
	const [state, setState] = useState<PushNotificationState | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const applyState = useCallback((next: PushNotificationState) => {
		setState(next);
		if (!next.supported) {
			setSupport({ supported: false, reason: next.reason });
		}
	}, []);

	async function load() {
		if (!support?.supported) return;
		setLoading(true);
		setError(null);
		try {
			applyState(await getPushNotificationState());
		} catch (cause) {
			setError(failureMessage(cause, "Could not read notification settings."));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		let cancelled = false;
		const detectedSupport = getPushNotificationSupport();
		setSupport(detectedSupport);
		if (!detectedSupport.supported) {
			setLoading(false);
			return;
		}
		void getPushNotificationState().then(
			(next) => {
				if (!cancelled) {
					applyState(next);
					setLoading(false);
				}
			},
			(cause) => {
				if (!cancelled) {
					setError(
						failureMessage(cause, "Could not read notification settings."),
					);
					setLoading(false);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [applyState]);

	async function run(
		action: () => Promise<PushNotificationState>,
		fallback: string,
	) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			applyState(await action());
		} catch (cause) {
			setError(failureMessage(cause, fallback));
			try {
				applyState(await getPushNotificationState());
			} catch {
				// Keep the last usable state alongside the original action error.
			}
		} finally {
			setBusy(false);
		}
	}

	function updatePreferences(patch: Partial<PushNotificationPreferences>) {
		if (!state?.enabled) return;
		void run(
			() =>
				updatePushNotificationPreferences({
					...state.preferences,
					...patch,
				}),
			"Could not save notification preferences.",
		);
	}

	const controlsDisabled = busy || !state?.enabled;

	return (
		<Section
			title="Notifications"
			id="forge-section-notifications"
			description="Optional alerts for this device when Hlid is backgrounded or closed."
		>
			{support !== null && !support.supported ? (
				<div role="note" className="space-y-1 px-4 py-3">
					<div className="text-sm text-foreground">
						Notifications are unavailable here
					</div>
					<p className="text-xs text-muted-foreground">
						{unsupportedReasonLabel(support.reason)}
					</p>
					<p className="text-xs text-muted-foreground/70">
						On iPhone and iPad, install Hlid on the Home Screen before enabling
						notifications.
					</p>
				</div>
			) : loading || support === null ? (
				<output className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
					<LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
					Loading notification settings…
				</output>
			) : state ? (
				<>
					<Field
						id="forge-setting-notifications-device"
						label="This device"
						hint="off by default; Hlid only asks for permission after you choose Enable"
					>
						<button
							type="button"
							disabled={busy || state.permission === "denied"}
							onClick={() =>
								void run(
									state.enabled
										? disablePushNotifications
										: enablePushNotifications,
									state.enabled
										? "Could not disable notifications on this device."
										: "Could not enable notifications on this device.",
								)
							}
							className={`min-h-11 border px-3 py-1.5 text-[10px] tracking-widest uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0 ${
								state.enabled
									? "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
									: "border-primary/40 text-primary hover:bg-primary/10"
							}`}
						>
							{busy
								? "WORKING…"
								: state.enabled
									? "DISABLE ON THIS DEVICE"
									: "ENABLE ON THIS DEVICE"}
						</button>
					</Field>
					<Field
						id="forge-setting-notification-permission"
						label="Permission"
						hint={
							state.permission === "denied"
								? "allow notifications in this browser or device's settings, then reload Hlid"
								: "notification visibility, sound, Focus, and summaries remain controlled by the device"
						}
					>
						<span className="text-xs text-muted-foreground">
							{permissionLabel(state)}
						</span>
					</Field>
					<Field
						id="forge-setting-notifications-needs-attention"
						label="Needs attention"
						hint="approvals, questions, plan review, blocked goals, errors, and failed background work"
					>
						<NotificationToggle
							checked={state.preferences.needsAttention}
							disabled={controlsDisabled}
							label={state.preferences.needsAttention ? "on" : "off"}
							name="Needs attention notifications"
							onChange={(needsAttention) =>
								updatePreferences({ needsAttention })
							}
						/>
					</Field>
					<Field
						id="forge-setting-notifications-work-finished"
						label="Work finished"
						hint="optional alerts when a top-level Raven session becomes ready; delegated child completions stay with their parent"
					>
						<NotificationToggle
							checked={state.preferences.workFinished}
							disabled={controlsDisabled}
							label={state.preferences.workFinished ? "on" : "off"}
							name="Work finished notifications"
							onChange={(workFinished) => updatePreferences({ workFinished })}
						/>
					</Field>
					<Field
						id="forge-setting-notifications-lock-screen"
						label="Lock Screen wording"
						hint="Generic hides session names and reasons; Detailed includes them"
					>
						<select
							value={state.preferences.detail}
							disabled={controlsDisabled}
							onChange={(event) =>
								updatePreferences({
									detail: event.target
										.value as PushNotificationPreferences["detail"],
								})
							}
							className="min-h-11 w-36 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
						>
							<option value="generic">Generic</option>
							<option value="detailed">Detailed</option>
						</select>
					</Field>
				</>
			) : (
				<div className="flex items-center justify-between gap-3 px-4 py-3">
					<p role="alert" className="text-xs text-destructive/80">
						{error ?? "Notification settings are unavailable."}
					</p>
					<button
						type="button"
						onClick={() => void load()}
						className="min-h-11 shrink-0 border border-border px-3 py-1.5 text-[10px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground lg:min-h-0"
					>
						RETRY
					</button>
				</div>
			)}
			{error && state && (
				<div role="alert" className="px-4 py-2 text-xs text-destructive/80">
					{error}
				</div>
			)}
		</Section>
	);
}
