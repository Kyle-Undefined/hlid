import { LoaderCircle } from "lucide-react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	disablePushNotifications,
	enablePushNotifications,
	getPushNotificationDevices,
	getPushNotificationHistory,
	getPushNotificationState,
	getPushNotificationSupport,
	type PushCompletionMinimumMinutes,
	type PushIsoWeekday,
	type PushNotificationDevice,
	type PushNotificationDevicePatch,
	type PushNotificationHistoryDelivery,
	type PushNotificationHistoryEvent,
	type PushNotificationPreferences,
	type PushNotificationQuietHours,
	type PushNotificationState,
	type PushNotificationSupport,
	type PushNotificationTestScenario,
	type PushNotificationUnsupportedReason,
	pausePushNotifications,
	renamePushNotificationDevice,
	revokePushNotificationDevice,
	sendTestPushNotification,
	updatePushNotificationDevice,
	updatePushNotificationPreferences,
} from "#/lib/pushNotifications";
import { Field, Section } from "./fields";

function failureMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isRepairReady(
	cause: unknown,
): cause is Error & { code: "repair-ready" } {
	return (
		cause instanceof Error && "code" in cause && cause.code === "repair-ready"
	);
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

function localDateTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

type PauseDurationUnit = "minutes" | "hours" | "days";

export function notificationPauseDurationMs(
	value: string,
	unit: PauseDurationUnit,
): number | null {
	const amount = Number(value);
	if (!Number.isSafeInteger(amount) || amount <= 0) return null;
	const multiplier =
		unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
	const duration = amount * multiplier;
	return Number.isSafeInteger(duration) ? duration : null;
}

export function notificationPauseUntilMs(
	value: string,
	now = Date.now(),
): number | null {
	if (!value) return null;
	const timestamp = new Date(value).getTime();
	return Number.isSafeInteger(timestamp) && timestamp > now ? timestamp : null;
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

const WEEKDAYS: Array<{ value: PushIsoWeekday; label: string }> = [
	{ value: 1, label: "Mon" },
	{ value: 2, label: "Tue" },
	{ value: 3, label: "Wed" },
	{ value: 4, label: "Thu" },
	{ value: 5, label: "Fri" },
	{ value: 6, label: "Sat" },
	{ value: 7, label: "Sun" },
];

function currentTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function defaultQuietHours(): PushNotificationQuietHours {
	return {
		timezone: currentTimezone(),
		start: "22:00",
		end: "07:00",
		weekdays: WEEKDAYS.map((day) => day.value),
		allowRequests: true,
		allowProblems: true,
	};
}

function validTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
		return value.length > 0 && value.length <= 64;
	} catch {
		return false;
	}
}

export function notificationQuietHoursValid(
	value: PushNotificationQuietHours | null,
): boolean {
	return (
		value === null ||
		(validTimezone(value.timezone) &&
			/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) &&
			/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end) &&
			value.weekdays.length >= 1 &&
			value.weekdays.length <= 7 &&
			new Set(value.weekdays).size === value.weekdays.length)
	);
}

function QuietHoursFields({
	value,
	disabled,
	name,
	onChange,
}: {
	value: PushNotificationQuietHours | null;
	disabled: boolean;
	name: string;
	onChange: (value: PushNotificationQuietHours | null) => void;
}) {
	const valid = notificationQuietHoursValid(value);
	return (
		<div className="w-full min-w-0 space-y-2">
			<NotificationToggle
				checked={value !== null}
				disabled={disabled}
				label={value === null ? "off" : "on"}
				name={`${name} quiet hours`}
				onChange={(enabled) => onChange(enabled ? defaultQuietHours() : null)}
			/>
			{value !== null && (
				<div className="min-w-0 space-y-2 border border-border/60 bg-background/30 p-2.5">
					<label className="block min-w-0 text-[10px] text-muted-foreground">
						Timezone
						<input
							aria-label={`${name} quiet hours timezone`}
							aria-invalid={!validTimezone(value.timezone)}
							value={value.timezone}
							maxLength={64}
							disabled={disabled}
							onChange={(event) =>
								onChange({ ...value, timezone: event.target.value.trim() })
							}
							placeholder="America/New_York"
							className="mt-1 min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-40 lg:min-h-0"
						/>
					</label>
					<div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2">
						<label className="text-[10px] text-muted-foreground">
							Starts
							<input
								type="time"
								aria-label={`${name} quiet hours start`}
								value={value.start}
								disabled={disabled}
								onChange={(event) =>
									onChange({ ...value, start: event.target.value })
								}
								className="mt-1 min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground disabled:opacity-40 lg:min-h-0"
							/>
						</label>
						<label className="text-[10px] text-muted-foreground">
							Ends
							<input
								type="time"
								aria-label={`${name} quiet hours end`}
								value={value.end}
								disabled={disabled}
								onChange={(event) =>
									onChange({ ...value, end: event.target.value })
								}
								className="mt-1 min-h-11 w-full min-w-0 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground disabled:opacity-40 lg:min-h-0"
							/>
						</label>
					</div>
					<fieldset className="min-w-0 space-y-1">
						<legend className="text-[10px] text-muted-foreground">Days</legend>
						<div className="grid grid-cols-4 gap-1 @xl:grid-cols-7">
							{WEEKDAYS.map((day) => (
								<label
									key={day.value}
									className="flex min-h-11 items-center justify-center gap-1 border border-border px-1 text-[9px] text-muted-foreground lg:min-h-0 lg:py-1"
								>
									<input
										type="checkbox"
										aria-label={`${name} quiet hours ${day.label}`}
										checked={value.weekdays.includes(day.value)}
										disabled={disabled}
										onChange={(event) => {
											const weekdays = event.target.checked
												? [...value.weekdays, day.value].sort()
												: value.weekdays.filter(
														(candidate) => candidate !== day.value,
													);
											onChange({ ...value, weekdays });
										}}
										className="h-3.5 w-3.5 accent-primary"
									/>
									{day.label}
								</label>
							))}
						</div>
					</fieldset>
					<div className="space-y-1.5">
						<NotificationToggle
							checked={value.allowRequests}
							disabled={disabled}
							label="allow requests during quiet hours"
							name={`${name} allow requests during quiet hours`}
							onChange={(allowRequests) =>
								onChange({ ...value, allowRequests })
							}
						/>
						<NotificationToggle
							checked={value.allowProblems}
							disabled={disabled}
							label="allow problems during quiet hours"
							name={`${name} allow problems during quiet hours`}
							onChange={(allowProblems) =>
								onChange({ ...value, allowProblems })
							}
						/>
					</div>
					{!valid && (
						<div role="alert" className="text-[10px] text-destructive/80">
							Use a valid IANA timezone and choose at least one day.
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function notificationProfileKey(preferences: PushNotificationPreferences) {
	return JSON.stringify(preferences);
}

function notificationQuietHoursKey(
	quietHours: PushNotificationQuietHours | null,
): string {
	return JSON.stringify(quietHours);
}

function CompactNotificationProfileEditor({
	preferences,
	disabled,
	name,
	onChange,
}: {
	preferences: PushNotificationPreferences;
	disabled: boolean;
	name: string;
	onChange: Dispatch<SetStateAction<PushNotificationPreferences>>;
}) {
	return (
		<div className="min-w-0 space-y-3">
			<div className="grid gap-2 @xl:grid-cols-2">
				<NotificationToggle
					checked={preferences.requests}
					disabled={disabled}
					label="requests"
					name={`${name} request notifications`}
					onChange={(requests) =>
						onChange((current) => ({ ...current, requests }))
					}
				/>
				<NotificationToggle
					checked={preferences.problems}
					disabled={disabled}
					label="problems"
					name={`${name} problem notifications`}
					onChange={(problems) =>
						onChange((current) => ({ ...current, problems }))
					}
				/>
				<NotificationToggle
					checked={preferences.workFinished}
					disabled={disabled}
					label="work finished"
					name={`${name} work finished notifications`}
					onChange={(workFinished) =>
						onChange((current) => ({ ...current, workFinished }))
					}
				/>
			</div>
			<div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-2">
				<label className="min-w-0 text-[10px] text-muted-foreground">
					Completion minimum
					<select
						aria-label={`${name} completion minimum runtime`}
						value={preferences.completionMinimumMinutes}
						disabled={disabled || !preferences.workFinished}
						onChange={(event) =>
							onChange((current) => ({
								...current,
								completionMinimumMinutes: Number(
									event.target.value,
								) as PushCompletionMinimumMinutes,
							}))
						}
						className="mt-1 min-h-11 w-full min-w-0 border border-border bg-input px-2 py-1.5 text-xs text-foreground disabled:opacity-40 lg:min-h-0"
					>
						<option value={0}>No minimum</option>
						<option value={1}>1 minute</option>
						<option value={5}>5 minutes</option>
						<option value={10}>10 minutes</option>
					</select>
				</label>
				<label className="min-w-0 text-[10px] text-muted-foreground">
					Wording
					<select
						aria-label={`${name} lock screen wording`}
						value={preferences.detail}
						disabled={disabled}
						onChange={(event) =>
							onChange((current) => ({
								...current,
								detail: event.target
									.value as PushNotificationPreferences["detail"],
							}))
						}
						className="mt-1 min-h-11 w-full min-w-0 border border-border bg-input px-2 py-1.5 text-xs text-foreground disabled:opacity-40 lg:min-h-0"
					>
						<option value="generic">Generic</option>
						<option value="detailed">Detailed</option>
					</select>
				</label>
			</div>
			<QuietHoursFields
				value={preferences.quietHours}
				disabled={disabled}
				name={name}
				onChange={(quietHours) =>
					onChange((current) => ({ ...current, quietHours }))
				}
			/>
		</div>
	);
}

function CurrentQuietHoursEditor({
	value,
	disabled,
	onSave,
}: {
	value: PushNotificationQuietHours | null;
	disabled: boolean;
	onSave: (value: PushNotificationQuietHours | null) => void;
}) {
	const [draft, setDraft] = useState(value);
	const valueKey = notificationQuietHoursKey(value);
	const acceptedValueKey = useRef(valueKey);
	useEffect(() => {
		setDraft((current) => {
			const currentKey = notificationQuietHoursKey(current);
			if (valueKey === acceptedValueKey.current) return current;
			if (currentKey !== acceptedValueKey.current && currentKey !== valueKey)
				return current;
			acceptedValueKey.current = valueKey;
			return value;
		});
	}, [value, valueKey]);
	const dirty = notificationQuietHoursKey(draft) !== valueKey;
	const valid = notificationQuietHoursValid(draft);
	return (
		<div className="w-full min-w-0 space-y-2 @4xl:w-[30rem]">
			<QuietHoursFields
				value={draft}
				disabled={disabled}
				name="Current device"
				onChange={setDraft}
			/>
			{dirty && (
				<button
					type="button"
					disabled={disabled || !valid}
					onClick={() => onSave(draft)}
					className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
				>
					SAVE QUIET HOURS
				</button>
			)}
		</div>
	);
}

function DeviceCard({
	device,
	disabled,
	now,
	onRename,
	onRevoke,
	onUpdate,
}: {
	device: PushNotificationDevice;
	disabled: boolean;
	now: number;
	onRename: (id: string, name: string) => Promise<void>;
	onRevoke: (device: PushNotificationDevice) => Promise<void>;
	onUpdate: (id: string, patch: PushNotificationDevicePatch) => Promise<void>;
}) {
	const [name, setName] = useState(device.name);
	const [profile, setProfile] = useState(device.preferences);
	const acceptedProfileKey = useRef(notificationProfileKey(device.preferences));
	const [confirmRevoke, setConfirmRevoke] = useState(false);
	const deviceProfileKey = notificationProfileKey(device.preferences);
	useEffect(() => {
		setName(device.name);
		setProfile((current) => {
			const currentKey = notificationProfileKey(current);
			if (deviceProfileKey === acceptedProfileKey.current) return current;
			if (
				currentKey !== acceptedProfileKey.current &&
				currentKey !== deviceProfileKey
			)
				return current;
			acceptedProfileKey.current = deviceProfileKey;
			return device.preferences;
		});
		setConfirmRevoke(false);
	}, [device.name, device.preferences, deviceProfileKey]);
	const cleanName = name.trim();
	const profileDirty =
		notificationProfileKey(profile) !==
		notificationProfileKey(device.preferences);
	const profileValid = notificationQuietHoursValid(profile.quietHours);
	const latestWasFailure =
		device.failureCount > 0 &&
		device.lastFailureAt !== null &&
		(device.lastAcceptedAt === null ||
			device.lastFailureAt > device.lastAcceptedAt);
	const health = latestWasFailure
		? `${device.failureCount} failed attempt${device.failureCount === 1 ? "" : "s"}; last ${localDateTime(device.lastFailureAt ?? 0)}`
		: device.lastAcceptedAt
			? `Last accepted ${localDateTime(device.lastAcceptedAt)}`
			: "No delivery result recorded yet";
	return (
		<div className="min-w-0 space-y-2 border border-border bg-background/40 p-3">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="min-w-0 text-[10px] tracking-widest text-muted-foreground uppercase">
					{device.current ? "This device" : "Subscribed device"}
				</div>
				<span className="shrink-0 text-[9px] text-muted-foreground/60">
					{device.enabled ? "enabled" : "disabled"}
				</span>
			</div>
			<div className="flex min-w-0 flex-col gap-2 @xl:flex-row">
				<input
					aria-label={`Name for ${device.name}`}
					value={name}
					maxLength={80}
					disabled={disabled}
					onChange={(event) => setName(event.target.value)}
					className="min-h-11 min-w-0 flex-1 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-40 lg:min-h-0"
				/>
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						aria-label={`Save name for ${device.name}`}
						disabled={disabled || !cleanName || cleanName === device.name}
						onClick={() => void onRename(device.id, cleanName)}
						className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
					>
						SAVE
					</button>
					{confirmRevoke ? (
						<>
							<button
								type="button"
								aria-label={`Cancel revoking ${device.name}`}
								disabled={disabled}
								onClick={() => setConfirmRevoke(false)}
								className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
							>
								CANCEL
							</button>
							<button
								type="button"
								aria-label={`Confirm revoke ${device.name}`}
								disabled={disabled}
								onClick={() => {
									setConfirmRevoke(false);
									void onRevoke(device);
								}}
								className="min-h-11 border border-destructive/40 px-3 py-1.5 text-[9px] tracking-widest text-destructive uppercase hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
							>
								CONFIRM REVOKE
							</button>
						</>
					) : (
						<button
							type="button"
							aria-label={`Revoke ${device.name}`}
							disabled={disabled}
							onClick={() => setConfirmRevoke(true)}
							className="min-h-11 border border-destructive/30 px-3 py-1.5 text-[9px] tracking-widest text-destructive/70 uppercase hover:bg-destructive/5 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
						>
							REVOKE
						</button>
					)}
				</div>
			</div>
			{!device.current && (
				<details className="min-w-0 border-t border-border/50 pt-2">
					<summary className="flex min-h-11 cursor-pointer items-center text-[9px] tracking-widest text-muted-foreground uppercase hover:text-foreground lg:min-h-0">
						EDIT NOTIFICATION PROFILE
					</summary>
					<div className="min-w-0 space-y-3 pt-3">
						<CompactNotificationProfileEditor
							preferences={profile}
							disabled={disabled}
							name={device.name}
							onChange={setProfile}
						/>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<span className="text-[10px] text-muted-foreground/60">
								Changes affect only {device.name}.
							</span>
							<button
								type="button"
								aria-label={`Save notification profile for ${device.name}`}
								disabled={disabled || !profileDirty || !profileValid}
								onClick={() =>
									void onUpdate(device.id, { preferences: profile })
								}
								className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
							>
								SAVE PROFILE
							</button>
						</div>
					</div>
				</details>
			)}
			<div className="space-y-0.5 text-[10px] text-muted-foreground/60">
				<div>{health}</div>
				{device.pausedIndefinitely ? (
					<div>Paused until manually resumed</div>
				) : device.pausedUntil && device.pausedUntil > now ? (
					<div>Paused until {localDateTime(device.pausedUntil)}</div>
				) : null}
				<div>Added {localDateTime(device.createdAt)}</div>
				<div>Updated {localDateTime(device.lastSeenAt)}</div>
			</div>
		</div>
	);
}

function historyCategoryLabel(
	category: PushNotificationHistoryEvent["category"],
): string {
	if (category === "request") return "Request";
	if (category === "problem") return "Problem";
	return "Completion";
}

function historyDeliveryLabel(
	delivery: PushNotificationHistoryDelivery,
): string {
	if (delivery.openedAt !== null) return "opened";
	if (delivery.dismissedAt !== null) return "dismissed";
	if (delivery.displayedAt !== null) return "displayed";
	if (delivery.status === "suppressed" && delivery.reason)
		return `suppressed · ${delivery.reason.replaceAll("_", " ")}`;
	if (delivery.status === "failed" && delivery.reason)
		return `failed · ${delivery.reason.replaceAll("_", " ")}`;
	if (delivery.status === "queued") {
		const details = [
			delivery.reason?.replaceAll("_", " "),
			delivery.nextAttemptAt === null
				? null
				: `next ${localDateTime(delivery.nextAttemptAt)}`,
		].filter((detail): detail is string => Boolean(detail));
		return ["queued", ...details].join(" · ");
	}
	return delivery.status;
}

function NotificationHistoryList({
	events,
}: {
	events: PushNotificationHistoryEvent[];
}) {
	return (
		<ol className="w-full min-w-0 space-y-2 @4xl:w-[30rem]">
			{events.map((event) => (
				<li
					key={event.id}
					className="min-w-0 border border-border bg-background/40 p-2.5"
				>
					<div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
						<div className="min-w-0">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								{historyCategoryLabel(event.category)} · {event.sourceKind}
							</div>
							<div className="mt-0.5 break-words text-xs text-foreground/85">
								{event.label ?? event.sourceId}
							</div>
						</div>
						<time
							dateTime={new Date(event.occurredAt).toISOString()}
							className="shrink-0 text-[9px] text-muted-foreground/60"
						>
							{localDateTime(event.occurredAt)}
						</time>
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground/60">
						{event.status.replaceAll("_", " ")}
						{event.statusReason
							? ` · ${event.statusReason.replaceAll("_", " ")}`
							: ""}
						{event.reason && event.reason !== event.statusReason
							? ` · ${event.reason.replaceAll("_", " ")}`
							: ""}
					</div>
					{event.deliveries.length === 0 ? (
						<div className="mt-1.5 text-[10px] text-muted-foreground/45">
							No device delivery decision recorded.
						</div>
					) : (
						<ul
							aria-label={`Device delivery states for ${event.label ?? event.sourceId}`}
							className="mt-1.5 flex min-w-0 flex-wrap gap-1"
						>
							{event.deliveries.map((delivery) => (
								<li
									key={delivery.id}
									className="max-w-full break-words border border-border/60 bg-secondary/20 px-1.5 py-1 text-[9px] text-muted-foreground/75"
								>
									{delivery.device.name}: {historyDeliveryLabel(delivery)}
								</li>
							))}
						</ul>
					)}
				</li>
			))}
		</ol>
	);
}

export function NotificationsSection() {
	const [support, setSupport] = useState<PushNotificationSupport | null>(null);
	const [state, setState] = useState<PushNotificationState | null>(null);
	const [devices, setDevices] = useState<PushNotificationDevice[]>([]);
	const [history, setHistory] = useState<PushNotificationHistoryEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [devicesLoading, setDevicesLoading] = useState(true);
	const [historyLoading, setHistoryLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deviceError, setDeviceError] = useState<string | null>(null);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [currentTime, setCurrentTime] = useState(() => Date.now());
	const [testScenario, setTestScenario] =
		useState<PushNotificationTestScenario>("delivery");
	const [pauseDuration, setPauseDuration] = useState("1");
	const [pauseDurationUnit, setPauseDurationUnit] =
		useState<PauseDurationUnit>("hours");
	const [pauseUntil, setPauseUntil] = useState("");
	const applyState = useCallback((next: PushNotificationState) => {
		setState(next);
		if (!next.supported) {
			setSupport({ supported: false, reason: next.reason });
		}
	}, []);

	const loadDevices = useCallback(async (): Promise<boolean> => {
		setDevicesLoading(true);
		setDeviceError(null);
		try {
			setDevices(await getPushNotificationDevices());
			return true;
		} catch (cause) {
			setDeviceError(
				failureMessage(cause, "Could not read subscribed devices."),
			);
			return false;
		} finally {
			setDevicesLoading(false);
		}
	}, []);

	const loadHistory = useCallback(async (): Promise<boolean> => {
		setHistoryLoading(true);
		setHistoryError(null);
		try {
			setHistory(await getPushNotificationHistory(20));
			return true;
		} catch (cause) {
			setHistoryError(
				failureMessage(cause, "Could not read notification history."),
			);
			return false;
		} finally {
			setHistoryLoading(false);
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
		void loadHistory();
		void getPushNotificationDevices()
			.then((nextDevices) => {
				if (!cancelled) setDevices(nextDevices);
			})
			.catch((cause) => {
				if (!cancelled) {
					setDeviceError(
						failureMessage(cause, "Could not read subscribed devices."),
					);
				}
			})
			.finally(() => {
				if (!cancelled) setDevicesLoading(false);
			});
		if (!detectedSupport.supported) {
			setLoading(false);
		} else {
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
		}
		return () => {
			cancelled = true;
		};
	}, [applyState, loadHistory]);

	async function run(
		action: () => Promise<PushNotificationState>,
		fallback: string,
		refreshDevices = false,
	) {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			applyState(await action());
		} catch (cause) {
			if (isRepairReady(cause)) setNotice(cause.message);
			else setError(failureMessage(cause, fallback));
			try {
				applyState(await getPushNotificationState());
			} catch {
				// Keep the last usable state alongside the original action error.
			}
		} finally {
			if (refreshDevices) await loadDevices();
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

	async function sendTest() {
		if (busy || !state?.enabled) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await sendTestPushNotification(testScenario);
			if (result.subscriptionRemoved) {
				try {
					applyState(await getPushNotificationState());
				} catch {
					// The provider result remains authoritative even if state refresh fails.
				}
				setError(
					"The push service rejected this subscription. Enable this device again to repair it.",
				);
			} else if (result.accepted && result.acceptedAt) {
				setNotice(
					`Accepted by the push service at ${localDateTime(result.acceptedAt)}. Display is controlled by this device.`,
				);
			} else {
				setError("The push service did not accept the test notification.");
			}
			await loadDevices();
		} catch (cause) {
			setError(failureMessage(cause, "Could not send a test notification."));
		} finally {
			setBusy(false);
		}
	}

	async function renameDevice(id: string, name: string) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await renamePushNotificationDevice(id, name);
			setDevices((current) =>
				current.map((device) =>
					device.id === id ? { ...device, name } : device,
				),
			);
			setNotice(`Renamed this subscription to ${name}.`);
			// Relist so server-owned current-device attribution cannot be lost to a
			// partial/mid-migration rename response.
			await loadDevices();
		} catch (cause) {
			setError(failureMessage(cause, "Could not rename this device."));
		} finally {
			setBusy(false);
		}
	}

	async function updateDevice(id: string, patch: PushNotificationDevicePatch) {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const updated = await updatePushNotificationDevice(id, patch);
			setDevices((current) =>
				current.map((device) => (device.id === id ? updated : device)),
			);
			setNotice(`Updated ${updated.name}'s notification profile.`);
		} catch (cause) {
			setError(
				failureMessage(cause, "Could not update this device's notifications."),
			);
		} finally {
			setBusy(false);
		}
	}

	async function revokeDevice(device: PushNotificationDevice) {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			if (device.current && support?.supported)
				applyState(await disablePushNotifications());
			else await revokePushNotificationDevice(device.id);
			setDevices((current) =>
				current.filter((candidate) => candidate.id !== device.id),
			);
			setNotice(`Revoked ${device.name}.`);
			await loadDevices();
		} catch (cause) {
			setError(failureMessage(cause, "Could not revoke this device."));
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		const now = Date.now();
		const expiries = [
			state?.pausedUntil ?? null,
			...devices
				.filter((device) => !device.pausedIndefinitely)
				.map((device) => device.pausedUntil),
		].filter((expiresAt): expiresAt is number => expiresAt !== null);
		if (expiries.length === 0) return;
		const futureExpiries = expiries.filter((expiresAt) => expiresAt > now);
		if (futureExpiries.length === 0) {
			if (expiries.some((expiresAt) => expiresAt > currentTime)) {
				setCurrentTime(now);
			}
			return;
		}
		const expiresAt = Math.min(...futureExpiries);
		const delay = expiresAt - now;
		const timer = window.setTimeout(
			() => setCurrentTime(Date.now()),
			Math.min(delay + 25, 2_147_483_647),
		);
		return () => window.clearTimeout(timer);
	}, [currentTime, devices, state?.pausedUntil]);

	const pausedUntil =
		state?.pausedUntil && state.pausedUntil > currentTime
			? state.pausedUntil
			: null;
	const paused = state?.pausedIndefinitely === true || pausedUntil !== null;
	const pauseDurationMilliseconds = notificationPauseDurationMs(
		pauseDuration,
		pauseDurationUnit,
	);
	const pauseUntilMilliseconds = notificationPauseUntilMs(pauseUntil);
	const controlsDisabled = busy || !state?.enabled;

	return (
		<Section
			title="Notifications"
			id="forge-section-notifications"
			description="Optional alerts for your subscribed devices when Hlid is backgrounded or closed."
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
						hint={
							state.reenableRequired
								? "this browser's prior subscription can no longer deliver; repair requires a click"
								: "off by default; Hlid only asks for permission after you choose Enable"
						}
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
									true,
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
									: state.reenableRequired
										? "REPAIR ON THIS DEVICE"
										: "ENABLE ON THIS DEVICE"}
						</button>
					</Field>
					<Field
						id="forge-setting-notification-permission"
						label="Permission"
						hint={
							state.permission === "denied"
								? "allow notifications in this browser or device's settings, then reload Hlid"
								: "visibility, sound, Focus, and summaries remain controlled by the device"
						}
					>
						<span className="text-xs text-muted-foreground">
							{permissionLabel(state)}
						</span>
					</Field>
					<Field
						id="forge-setting-notifications-requests"
						label="Requests"
						hint="approvals, questions, plan reviews, and routines that need action"
					>
						<NotificationToggle
							checked={state.preferences.requests}
							disabled={controlsDisabled}
							label={state.preferences.requests ? "on" : "off"}
							name="Request notifications"
							onChange={(requests) => updatePreferences({ requests })}
						/>
					</Field>
					<Field
						id="forge-setting-notifications-problems"
						label="Problems"
						hint="blocked goals, errors, and failed background work"
					>
						<NotificationToggle
							checked={state.preferences.problems}
							disabled={controlsDisabled}
							label={state.preferences.problems ? "on" : "off"}
							name="Problem notifications"
							onChange={(problems) => updatePreferences({ problems })}
						/>
					</Field>
					<Field
						id="forge-setting-notifications-work-finished"
						label="Work finished"
						hint="top-level Raven sessions only; delegated child completions stay with their parent"
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
						id="forge-setting-notifications-completion-runtime"
						label="Completion minimum runtime"
						hint="skip completion alerts for quick work; Always notify and Notify when finished bypass this threshold"
					>
						<select
							value={state.preferences.completionMinimumMinutes}
							disabled={controlsDisabled || !state.preferences.workFinished}
							onChange={(event) =>
								updatePreferences({
									completionMinimumMinutes: Number(
										event.target.value,
									) as PushCompletionMinimumMinutes,
								})
							}
							className="min-h-11 w-40 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
						>
							<option value={0}>No minimum</option>
							<option value={1}>1 minute</option>
							<option value={5}>5 minutes</option>
							<option value={10}>10 minutes</option>
						</select>
					</Field>
					<Field
						id="forge-setting-notifications-lock-screen"
						label="Lock Screen wording"
						hint="Generic hides session names and reasons in the notification text; Detailed can include the reason, session, and completion duration. Both keep the exact safe tap destination"
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
					<Field
						id="forge-setting-notifications-quiet-hours"
						label="Quiet hours"
						hint="schedule recurring local quiet time; requests and problems can bypass it"
					>
						<CurrentQuietHoursEditor
							value={state.preferences.quietHours}
							disabled={controlsDisabled}
							onSave={(quietHours) => updatePreferences({ quietHours })}
						/>
					</Field>
					<Field
						id="forge-setting-notifications-pause"
						label="Pause this device"
						hint={
							state.pausedIndefinitely
								? "paused until you manually resume notifications"
								: pausedUntil
									? `paused until ${localDateTime(pausedUntil)}`
									: "choose a duration, an exact local time, or pause until you manually resume"
						}
					>
						<div className="flex max-w-full flex-col items-start gap-2">
							{paused ? (
								<button
									type="button"
									disabled={controlsDisabled}
									onClick={() =>
										void run(
											() => pausePushNotifications(null),
											"Could not resume notifications.",
											true,
										)
									}
									className="min-h-11 border border-primary/40 px-3 py-1.5 text-[9px] tracking-widest text-primary uppercase hover:bg-primary/10 disabled:opacity-40 lg:min-h-0"
								>
									RESUME
								</button>
							) : (
								<>
									<div className="flex max-w-full flex-wrap items-center gap-2">
										<input
											type="number"
											aria-label="Pause duration"
											min={1}
											step={1}
											value={pauseDuration}
											disabled={controlsDisabled}
											onChange={(event) => setPauseDuration(event.target.value)}
											className="min-h-11 w-20 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-40 lg:min-h-0"
										/>
										<select
											aria-label="Pause duration unit"
											value={pauseDurationUnit}
											disabled={controlsDisabled}
											onChange={(event) =>
												setPauseDurationUnit(
													event.target.value as PauseDurationUnit,
												)
											}
											className="min-h-11 border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-40 lg:min-h-0"
										>
											<option value="minutes">minutes</option>
											<option value="hours">hours</option>
											<option value="days">days</option>
										</select>
										<button
											type="button"
											disabled={
												controlsDisabled || pauseDurationMilliseconds === null
											}
											onClick={() => {
												if (pauseDurationMilliseconds === null) return;
												void run(
													() =>
														pausePushNotifications(
															Date.now() + pauseDurationMilliseconds,
														),
													"Could not pause notifications.",
													true,
												);
											}}
											className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
										>
											PAUSE FOR
										</button>
									</div>
									<div className="flex max-w-full flex-wrap items-center gap-2">
										<input
											type="datetime-local"
											aria-label="Pause until date and time"
											value={pauseUntil}
											disabled={controlsDisabled}
											onChange={(event) => setPauseUntil(event.target.value)}
											className="min-h-11 max-w-full border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-40 lg:min-h-0"
										/>
										<button
											type="button"
											disabled={
												controlsDisabled || pauseUntilMilliseconds === null
											}
											onClick={() => {
												if (pauseUntilMilliseconds === null) return;
												void run(
													() => pausePushNotifications(pauseUntilMilliseconds),
													"Could not pause notifications.",
													true,
												);
											}}
											className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
										>
											PAUSE UNTIL
										</button>
									</div>
									<button
										type="button"
										disabled={controlsDisabled}
										onClick={() =>
											void run(
												() => pausePushNotifications("indefinite"),
												"Could not pause notifications.",
												true,
											)
										}
										className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
									>
										UNTIL I RESUME
									</button>
								</>
							)}
						</div>
					</Field>
					<Field
						id="forge-setting-notifications-test"
						label="Test this device"
						hint="sends the selected preview through the real encrypted push path using this device's Generic or Detailed wording; previews do not change session state or consume overrides"
					>
						<div className="flex max-w-full flex-wrap gap-2">
							<select
								aria-label="Test notification form"
								value={testScenario}
								disabled={controlsDisabled}
								onChange={(event) =>
									setTestScenario(
										event.target.value as PushNotificationTestScenario,
									)
								}
								className="min-h-11 max-w-full border border-border bg-input px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-0"
							>
								<option value="delivery">Basic delivery</option>
								<option value="permission">Approval request</option>
								<option value="question">Question</option>
								<option value="plan_review">Plan review</option>
								<option value="problem">Problem</option>
								<option value="work_finished">Work finished</option>
								<option value="work_finished_batch">Completion batch</option>
							</select>
							<button
								type="button"
								disabled={controlsDisabled}
								onClick={() => void sendTest()}
								className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
							>
								SEND SELECTED PREVIEW
							</button>
						</div>
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
			<Field
				id="forge-setting-notifications-devices"
				label="Subscribed devices"
				hint="rename or revoke browsers and installed PWAs connected through this Hlid sign-in"
			>
				<div className="w-full min-w-0 space-y-2 @4xl:w-[30rem]">
					{devicesLoading && devices.length === 0 ? (
						<output className="flex items-center gap-2 text-xs text-muted-foreground">
							<LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
							Loading subscribed devices…
						</output>
					) : devices.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No subscribed devices.
						</p>
					) : (
						devices.map((device) => (
							<DeviceCard
								key={device.id}
								device={device}
								disabled={busy}
								now={currentTime}
								onRename={renameDevice}
								onRevoke={revokeDevice}
								onUpdate={updateDevice}
							/>
						))
					)}
					{deviceError && (
						<div className="flex flex-wrap items-center gap-2">
							<p
								role="alert"
								className="min-w-0 flex-1 text-xs text-destructive/80"
							>
								{deviceError}
							</p>
							<button
								type="button"
								disabled={devicesLoading}
								onClick={() => void loadDevices()}
								className="min-h-11 shrink-0 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
							>
								RETRY DEVICES
							</button>
						</div>
					)}
				</div>
			</Field>
			<Field
				id="forge-setting-notifications-history"
				label="Recent notification history"
				hint="the latest notification decisions and what happened on each target device"
			>
				<div className="w-full min-w-0 space-y-2 @4xl:w-[30rem]">
					<div className="flex justify-end">
						<button
							type="button"
							disabled={historyLoading}
							onClick={() => void loadHistory()}
							className="min-h-11 shrink-0 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:opacity-40 lg:min-h-0"
						>
							{historyLoading ? "REFRESHING…" : "REFRESH HISTORY"}
						</button>
					</div>
					{historyLoading && history.length === 0 ? (
						<output className="flex items-center gap-2 text-xs text-muted-foreground">
							<LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
							Loading notification history…
						</output>
					) : history.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No notification history yet.
						</p>
					) : (
						<NotificationHistoryList events={history} />
					)}
					{historyError && (
						<p role="alert" className="text-xs text-destructive/80">
							{historyError}
						</p>
					)}
				</div>
			</Field>
			{notice && (
				<output className="block px-4 py-2 text-xs text-status-success/80">
					{notice}
				</output>
			)}
			{error && state && (
				<div role="alert" className="px-4 py-2 text-xs text-destructive/80">
					{error}
				</div>
			)}
		</Section>
	);
}
