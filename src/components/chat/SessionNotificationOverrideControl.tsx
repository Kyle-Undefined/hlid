import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
	getSessionNotificationOverride,
	type SessionNotificationOverride,
	setSessionNotificationOverride,
} from "#/lib/pushNotifications";

const OPTIONS = [
	{
		value: "default",
		label: "Default",
		description: "Follow the normal notification rules.",
	},
	{
		value: "notify_once",
		label: "Notify once",
		description: "Send the next eligible alert, then return to Default.",
	},
	{
		value: "notify",
		label: "Always notify",
		description:
			"Always send this session's eligible alerts to subscribed devices.",
	},
	{
		value: "mute",
		label: "Mute",
		description: "Never notify for this session.",
	},
] as const satisfies ReadonlyArray<{
	value: SessionNotificationOverride;
	label: string;
	description: string;
}>;

export function SessionNotificationOverrideControl({
	sessionId,
}: {
	sessionId: string;
}) {
	const [mode, setMode] = useState<SessionNotificationOverride | null>(null);
	const [saving, setSaving] = useState<SessionNotificationOverride | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setMode(null);
		setError(null);
		void getSessionNotificationOverride(sessionId).then(
			(value) => {
				if (!cancelled) setMode(value);
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
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	async function select(next: SessionNotificationOverride) {
		if (saving || next === mode) return;
		const previous = mode;
		setMode(next);
		setSaving(next);
		setError(null);
		try {
			setMode(await setSessionNotificationOverride(sessionId, next));
		} catch (cause) {
			setMode(previous);
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save the session notification setting.",
			);
		} finally {
			setSaving(null);
		}
	}

	return (
		<div className="space-y-1 border-t border-border/50 pt-1">
			<div className="text-muted-foreground/40">notifications</div>
			{mode === null && !error ? (
				<output
					aria-label="Loading session notification setting"
					className="flex items-center gap-1.5 px-1.5 py-1 normal-case tracking-normal text-muted-foreground/60"
				>
					<LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
					Loading…
				</output>
			) : (
				OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-label={option.label}
						disabled={saving !== null || mode === null}
						aria-pressed={mode === option.value}
						onClick={() => void select(option.value)}
						className={`block w-full px-1.5 py-1 text-left normal-case tracking-normal transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
							mode === option.value
								? "bg-primary/10 text-primary"
								: "text-foreground/70 hover:bg-accent"
						}`}
					>
						<span className="flex items-center justify-between gap-2">
							<span>{option.label}</span>
							{saving === option.value && (
								<LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
							)}
						</span>
						<span className="mt-0.5 block text-[8px] leading-tight text-muted-foreground/45">
							{option.description}
						</span>
					</button>
				))
			)}
			{error && (
				<div
					role="alert"
					className="px-1.5 py-1 normal-case tracking-normal text-destructive/80"
				>
					{error}
				</div>
			)}
			<div className="px-1.5 pt-0.5 normal-case tracking-normal text-muted-foreground/30">
				Applies to this session on every device.
			</div>
		</div>
	);
}
