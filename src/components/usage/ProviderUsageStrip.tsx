import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderWindowCell } from "#/components/usage/UsageWindowSections";
import type { ProviderUsageSnapshot } from "#/db";
import {
	applyRateLimitToSnapshot,
	mergeFreshProviderSnapshots,
} from "#/lib/usageWindows";
import type { RateLimitMessage } from "#/server/protocol";

const PROVIDER_STRIP_KEY = "hlid_active_provider";

function initialProvider(
	providerIds: string[],
	preferredProviderId?: string,
): string {
	if (preferredProviderId && providerIds.includes(preferredProviderId)) {
		return preferredProviderId;
	}
	return providerIds[0] ?? "claude";
}

function storedProvider(providerIds: string[]): string | null {
	try {
		const stored = localStorage.getItem(PROVIDER_STRIP_KEY);
		return stored && providerIds.includes(stored) ? stored : null;
	} catch {
		// Storage may be unavailable in privacy-restricted contexts.
		return null;
	}
}

function storeProvider(providerId: string): void {
	try {
		localStorage.setItem(PROVIDER_STRIP_KEY, providerId);
	} catch {
		// Provider selection remains usable without persistence.
	}
}

export function ProviderUsageStrip({
	initial,
	liveQueryCount,
	rateLimit,
	preferredProviderId,
	tail,
	fetchFn,
}: {
	initial: ProviderUsageSnapshot[];
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	preferredProviderId?: string;
	tail?: React.ReactNode;
	fetchFn: () => Promise<ProviderUsageSnapshot[]>;
}) {
	const [snapshots, setSnapshots] = useState(initial);
	const fetchFnRef = useRef(fetchFn);
	fetchFnRef.current = fetchFn;
	const providerIds = useMemo(
		() => snapshots.map((snapshot) => snapshot.providerId),
		[snapshots],
	);
	const providerIdsRef = useRef(providerIds);
	providerIdsRef.current = providerIds;
	const refreshSequenceRef = useRef(0);
	const [activeProvider, setActiveProvider] = useState(() =>
		initialProvider(providerIds, preferredProviderId),
	);
	const activeSnapshot = snapshots.find(
		(snapshot) => snapshot.providerId === activeProvider,
	);
	const refreshRef = useRef(() => {
		const sequence = ++refreshSequenceRef.current;
		void fetchFnRef
			.current()
			.then((fresh) => {
				// A structured usage reading is broadcast just before the completed
				// query is committed. If that refresh races the post-done refresh, an
				// older zero-query response must not overwrite the newer ledger totals.
				if (sequence !== refreshSequenceRef.current) return;
				setSnapshots((previous) =>
					mergeFreshProviderSnapshots(fresh, previous),
				);
			})
			.catch(() => {});
	});

	useEffect(() => {
		if (preferredProviderId) return;
		const stored = storedProvider(providerIdsRef.current);
		if (stored) setActiveProvider(stored);
	}, [preferredProviderId]);

	useEffect(() => {
		if (liveQueryCount > 0) refreshRef.current();
	}, [liveQueryCount]);

	useEffect(() => {
		let id: ReturnType<typeof setInterval> | null = null;

		const stopPolling = () => {
			if (id === null) return;
			clearInterval(id);
			id = null;
		};
		const startPolling = () => {
			if (id !== null || document.visibilityState !== "visible") return;
			id = setInterval(() => refreshRef.current(), 60_000);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				refreshRef.current();
				startPolling();
			} else {
				stopPolling();
			}
		};

		startPolling();
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			stopPolling();
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);

	useEffect(() => {
		if (!rateLimit) return;
		setSnapshots((previous) =>
			previous.map((snapshot) => applyRateLimitToSnapshot(snapshot, rateLimit)),
		);
		// Re-read the authoritative query cost/token totals after the provider
		// window event. The server persists structured window data before done,
		// so this single refresh keeps every figure in the cell coherent.
		refreshRef.current();
	}, [rateLimit]);

	useEffect(() => {
		if (
			preferredProviderId &&
			providerIdsRef.current.includes(preferredProviderId)
		) {
			setActiveProvider(preferredProviderId);
		}
	}, [preferredProviderId]);

	const selectProvider = (providerId: string) => {
		setActiveProvider(providerId);
		storeProvider(providerId);
	};

	return (
		<div className="border-b border-border shrink-0 overflow-hidden">
			{snapshots.length > 1 && (
				<div className="flex items-center gap-1 px-3 pt-1.5 pb-0 border-b border-border/30">
					{snapshots.map((snapshot) => (
						<button
							key={snapshot.providerId}
							type="button"
							onClick={() => selectProvider(snapshot.providerId)}
							className={`text-[8px] tracking-widest uppercase px-2 py-0.5 transition-colors ${snapshot.providerId === activeProvider ? "text-foreground/70 border-b border-primary/60" : "text-muted-foreground/40 hover:text-muted-foreground/60"}`}
						>
							{snapshot.providerLabel}
						</button>
					))}
				</div>
			)}
			<div className="flex divide-x divide-border/40">
				{(activeSnapshot?.windows ?? []).map((window) => (
					<ProviderWindowCell
						key={window.windowId}
						win={window}
						estimatedCost={
							activeSnapshot?.providerId === "codex" ||
							activeSnapshot?.providerId === "claude"
						}
					/>
				))}
				{tail}
			</div>
		</div>
	);
}
