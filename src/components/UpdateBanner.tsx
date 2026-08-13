import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	fetchUpdateStatus,
	getUpdateServerSnapshot,
	getUpdateSnapshot,
	subscribeUpdateStatus,
} from "#/hooks/updateStore";
import {
	type ForgeRouteSearch,
	normalizeForgeNavigation,
} from "#/lib/forgeNavigation";

function dismissedKey(updateId: string) {
	return `hlid:update-dismissed:${updateId}`;
}

type UpdateNotice = {
	id: string;
	label: string;
	destination?: ForgeRouteSearch;
};

function isAtNoticeDestination(
	pathname: string,
	search: Record<string, unknown>,
	destination: ForgeRouteSearch | undefined,
): boolean {
	if (pathname !== "/forge") return false;
	const current = normalizeForgeNavigation(search);
	if (!destination) return current.category === "overview";
	const target = normalizeForgeNavigation(destination);
	return (
		current.category === target.category &&
		current.section === target.section &&
		current.view === target.view &&
		current.setting === target.setting &&
		current.target === target.target
	);
}

export function UpdateBanner() {
	const status = useSyncExternalStore(
		subscribeUpdateStatus,
		getUpdateSnapshot,
		getUpdateServerSnapshot,
	);
	const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const location = useLocation();
	const notices: UpdateNotice[] = [];
	if (status?.available && status.latest) {
		notices.push({
			id: `hlid:${status.latest}`,
			label: `Hlid v${status.latest} available`,
		});
	}
	for (const update of status?.cliUpdates ?? []) {
		if (!update.available || !update.latestVersion) continue;
		notices.push({
			id: update.noticeId ?? `${update.id}:${update.latestVersion}`,
			label: `${update.label}${update.surface === "desktop" ? "" : " CLI"} v${update.latestVersion} available`,
			...(update.noticeDestination
				? { destination: update.noticeDestination }
				: {}),
		});
	}
	const noticeIds = notices.map((notice) => notice.id).join("\0");
	const notice = notices.find(
		(candidate) =>
			!dismissedIds.has(candidate.id) &&
			!isAtNoticeDestination(
				location.pathname,
				location.search as Record<string, unknown>,
				candidate.destination,
			),
	);

	// Trigger the shared fetch once. No-op if already fetched.
	useEffect(() => {
		void fetchUpdateStatus();
	}, []);

	// Check dismissal whenever the available notices change. localStorage access
	// can throw in restricted contexts (Safari private mode, third-party
	// frame, quota errors) — fall back to "not dismissed" so the banner is
	// still visible rather than crashing the component.
	useEffect(() => {
		if (!noticeIds) return;
		try {
			const persisted = noticeIds
				.split("\0")
				.filter((id) => localStorage.getItem(dismissedKey(id)) === "1");
			if (persisted.length === 0) return;
			setDismissedIds((current) => {
				const next = new Set(current);
				for (const id of persisted) next.add(id);
				return next;
			});
		} catch {
			// Keep this session's dismissals and leave persisted notices visible.
		}
	}, [noticeIds]);

	function dismiss() {
		if (notice) {
			try {
				localStorage.setItem(dismissedKey(notice.id), "1");
			} catch {
				// localStorage unavailable — dismissal won't persist across
				// reloads but the banner still hides for this session.
			}
			setDismissedIds((current) => new Set(current).add(notice.id));
		}
	}

	// Notices whose full update UI is already visible are skipped while later
	// notices remain eligible.
	if (!notice) return null;

	return (
		<output
			aria-live="polite"
			className="absolute top-3 left-1/2 z-50 flex w-max max-w-[calc(100%_-_1.5rem)] min-w-0 -translate-x-1/2 items-center gap-2 rounded-full border border-primary/40 bg-background px-3 py-1.5 shadow-sm"
		>
			<Link
				to="/forge"
				search={notice.destination}
				className="min-w-0 whitespace-normal text-center text-[10px] leading-snug tracking-widest text-primary uppercase transition-colors [overflow-wrap:anywhere] hover:text-primary/80"
			>
				{notice.label}
			</Link>
			<button
				type="button"
				onClick={dismiss}
				aria-label="Dismiss update notification"
				className="shrink-0 text-sm leading-none text-primary/40 transition-colors hover:text-primary"
			>
				×
			</button>
		</output>
	);
}
