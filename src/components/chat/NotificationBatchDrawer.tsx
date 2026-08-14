import { CheckCheck, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	getPushNotificationBatch,
	markPushNotificationBatchRead,
	type PushNotificationBatchMember,
	type PushNotificationBatchState,
} from "#/lib/pushNotifications";

export interface NotificationBatchDrawerProps {
	batchId: string;
	onClose: () => void;
	onOpenSession: (sessionId: string) => void;
}

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

function memberLabel(member: PushNotificationBatchMember): string {
	return member.event?.label?.trim() || member.sessionId;
}

function localDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function withReadState(
	state: PushNotificationBatchState,
	readAt: number,
	sessionId?: string,
): PushNotificationBatchState {
	const members = state.members.map((member) =>
		sessionId === undefined || member.sessionId === sessionId
			? { ...member, readAt }
			: member,
	);
	const allRead =
		members.length > 0 && members.every((member) => member.readAt !== null);
	return {
		batch: allRead
			? { ...state.batch, status: "read", readAt, updatedAt: readAt }
			: state.batch,
		members,
	};
}

export function NotificationBatchDrawer({
	batchId,
	onClose,
	onOpenSession,
}: NotificationBatchDrawerProps) {
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const [state, setState] = useState<PushNotificationBatchState | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<"all" | string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setState(null);
		setLoading(true);
		setError(null);
		void getPushNotificationBatch(batchId).then(
			(next) => {
				if (!cancelled) {
					setState(next);
					setLoading(false);
				}
			},
			(cause) => {
				if (!cancelled) {
					setError(
						errorMessage(cause, "Could not read this notification batch."),
					);
					setLoading(false);
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [batchId]);

	useEffect(() => {
		closeButtonRef.current?.focus();
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	const members = useMemo(
		() =>
			[...(state?.members ?? [])].sort(
				(left, right) =>
					left.position - right.position ||
					left.eventId.localeCompare(right.eventId),
			),
		[state?.members],
	);
	const unreadCount = members.filter((member) => member.readAt === null).length;

	async function retry() {
		setLoading(true);
		setError(null);
		try {
			setState(await getPushNotificationBatch(batchId));
		} catch (cause) {
			setError(errorMessage(cause, "Could not read this notification batch."));
		} finally {
			setLoading(false);
		}
	}

	async function openMember(member: PushNotificationBatchMember) {
		if (busy) return;
		if (member.readAt === null) {
			setBusy(member.sessionId);
			setError(null);
			try {
				const readAt = await markPushNotificationBatchRead(
					batchId,
					member.sessionId,
				);
				setState((current) =>
					current ? withReadState(current, readAt, member.sessionId) : current,
				);
			} catch (cause) {
				setError(
					errorMessage(cause, "Could not update this notification read state."),
				);
				return;
			} finally {
				setBusy(null);
			}
		}
		onOpenSession(member.sessionId);
	}

	async function markAllRead() {
		if (!state || unreadCount === 0 || busy) return;
		setBusy("all");
		setError(null);
		try {
			const readAt = await markPushNotificationBatchRead(batchId);
			setState((current) =>
				current ? withReadState(current, readAt) : current,
			);
		} catch (cause) {
			setError(
				errorMessage(cause, "Could not mark this notification batch read."),
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<section
			role="dialog"
			aria-labelledby="notification-batch-title"
			aria-describedby="notification-batch-summary"
			className="fixed inset-x-3 top-14 z-50 flex max-h-[calc(100dvh-4.5rem)] min-w-0 flex-col overflow-hidden border border-border bg-background shadow-2xl sm:inset-x-auto sm:right-4 sm:w-96"
		>
			<header className="flex min-w-0 items-start justify-between gap-3 border-border border-b px-3 py-2.5">
				<div className="min-w-0">
					<h2
						id="notification-batch-title"
						className="text-xs font-medium tracking-wide text-foreground"
					>
						Finished work
					</h2>
					<p
						id="notification-batch-summary"
						className="mt-0.5 text-[10px] text-muted-foreground"
					>
						{loading
							? "Loading the exact sessions in this notification."
							: `${members.length} ${members.length === 1 ? "session" : "sessions"} · ${unreadCount} unread`}
					</p>
				</div>
				<button
					ref={closeButtonRef}
					type="button"
					onClick={onClose}
					aria-label="Close finished work"
					className="grid h-11 w-11 shrink-0 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground sm:h-8 sm:w-8"
				>
					<X aria-hidden className="h-4 w-4" />
				</button>
			</header>

			<div className="min-w-0 overflow-y-auto p-2.5">
				{loading ? (
					<output className="flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground">
						<LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
						Loading finished work…
					</output>
				) : state === null ? (
					<div className="space-y-2 py-2">
						<p className="text-xs text-muted-foreground">
							This notification batch is unavailable.
						</p>
						<button
							type="button"
							onClick={() => void retry()}
							className="min-h-11 border border-border px-3 py-1.5 text-[9px] tracking-widest text-muted-foreground uppercase hover:bg-accent hover:text-foreground sm:min-h-0"
						>
							Retry
						</button>
					</div>
				) : members.length === 0 ? (
					<p className="py-4 text-xs text-muted-foreground">
						No sessions remain in this notification batch.
					</p>
				) : (
					<ol className="min-w-0 space-y-1.5">
						{members.map((member) => {
							const label = memberLabel(member);
							const timestamp = member.event?.occurredAt ?? member.addedAt;
							const memberBusy = busy === member.sessionId;
							return (
								<li key={member.eventId} className="min-w-0">
									<button
										type="button"
										onClick={() => void openMember(member)}
										disabled={busy !== null}
										aria-label={`Open ${label}`}
										className="flex min-h-12 w-full min-w-0 items-center gap-2 border border-border bg-background/60 px-2.5 py-2 text-left hover:bg-accent disabled:cursor-wait disabled:opacity-60"
									>
										{memberBusy ? (
											<LoaderCircle
												aria-hidden
												className="h-3.5 w-3.5 shrink-0 animate-spin"
											/>
										) : (
											<span
												aria-hidden
												className={`h-2 w-2 shrink-0 rounded-full ${member.readAt === null ? "bg-status-warning" : "bg-muted-foreground/25"}`}
											/>
										)}
										<span className="min-w-0 flex-1">
											<span className="block break-words text-xs text-foreground/85">
												{label}
											</span>
											<time
												dateTime={new Date(timestamp).toISOString()}
												className="mt-0.5 block text-[9px] text-muted-foreground/60"
											>
												{localDateTime(timestamp)}
											</time>
										</span>
										<span className="shrink-0 text-[9px] tracking-wider text-muted-foreground uppercase">
											{member.readAt === null ? "Unread" : "Read"}
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				)}
				{error && (
					<p role="alert" className="mt-2 text-xs text-destructive/80">
						{error}
					</p>
				)}
			</div>

			{state && members.length > 0 && (
				<footer className="flex min-w-0 items-center justify-between gap-3 border-border border-t px-3 py-2">
					<span className="min-w-0 text-[10px] text-muted-foreground">
						Open a row to go to that exact session.
					</span>
					<button
						type="button"
						onClick={() => void markAllRead()}
						disabled={unreadCount === 0 || busy !== null}
						className="flex min-h-11 shrink-0 items-center gap-1.5 border border-border px-2.5 py-1.5 text-[9px] tracking-wider text-muted-foreground uppercase hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0"
					>
						{busy === "all" ? (
							<LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
						) : (
							<CheckCheck aria-hidden className="h-3 w-3" />
						)}
						Mark all read
					</button>
				</footer>
			)}
		</section>
	);
}
