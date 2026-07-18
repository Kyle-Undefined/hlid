import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderWindowCell } from "#/components/usage/UsageWindowSections";
import type { ProviderUsageSnapshot } from "#/db";
import {
	applyRateLimitToSnapshot,
	mergeFreshProviderSnapshots,
} from "#/lib/usageWindows";
import type { RateLimitMessage } from "#/server/protocol";

const PROVIDER_STRIP_KEY = "hlid_active_provider";
const PROVIDER_USAGE_CACHE_KEY = "hlid_provider_usage_snapshots";

function cachedProviderUsages(): ProviderUsageSnapshot[] {
	try {
		const parsed = JSON.parse(
			sessionStorage.getItem(PROVIDER_USAGE_CACHE_KEY) ?? "[]",
		) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(snapshot): snapshot is ProviderUsageSnapshot =>
				typeof snapshot === "object" &&
				snapshot !== null &&
				typeof snapshot.providerId === "string" &&
				typeof snapshot.providerLabel === "string" &&
				Array.isArray(snapshot.windows),
		);
	} catch {
		return [];
	}
}

function cacheProviderUsages(snapshots: ProviderUsageSnapshot[]): void {
	if (snapshots.length === 0) return;
	try {
		sessionStorage.setItem(PROVIDER_USAGE_CACHE_KEY, JSON.stringify(snapshots));
	} catch {
		// The stable shell still works if browser storage is unavailable.
	}
}

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
	initialStale = false,
	tail,
	fetchFn,
}: {
	initial: ProviderUsageSnapshot[];
	liveQueryCount: number;
	rateLimit: RateLimitMessage | null;
	preferredProviderId?: string;
	/** Initial data is a layout shell and should refresh immediately. */
	initialStale?: boolean;
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
				setSnapshots((previous) => {
					const merged = mergeFreshProviderSnapshots(fresh, previous);
					cacheProviderUsages(merged);
					return merged;
				});
			})
			.catch(() => {});
	});

	// Stats hydration is intentionally decoupled from Ledger navigation. Reconcile
	// each authoritative server snapshot when it arrives without discarding a
	// newer live high-water reading already shown in this strip.
	useEffect(() => {
		// Cockpit passes a stable layout shell on every route invalidation. It is
		// never authoritative data and must not zero a populated usage snapshot.
		if (initialStale) return;
		setSnapshots((previous) => mergeFreshProviderSnapshots(initial, previous));
		cacheProviderUsages(initial);
	}, [initial, initialStale]);

	useEffect(() => {
		const cached = cachedProviderUsages();
		if (cached.length > 0) {
			setSnapshots((previous) => mergeFreshProviderSnapshots(cached, previous));
		}

		// Routes may intentionally omit provider inventory from their blocking
		// loader or provide only a stable layout shell. Hydrate after first paint
		// instead of making page navigation depend on host/provider discovery.
		if (initialStale || initial.length === 0) refreshRef.current();
	}, [initial.length, initialStale]);

	useEffect(() => {
		if (preferredProviderId) return;
		const stored = storedProvider(providerIds);
		if (stored) setActiveProvider(stored);
	}, [preferredProviderId, providerIds]);

	useEffect(() => {
		if (providerIds.length === 0 || providerIds.includes(activeProvider))
			return;
		setActiveProvider(initialProvider(providerIds, preferredProviderId));
	}, [activeProvider, preferredProviderId, providerIds]);

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
		setSnapshots((previous) => {
			const updated = previous.map((snapshot) =>
				applyRateLimitToSnapshot(snapshot, rateLimit),
			);
			cacheProviderUsages(updated);
			return updated;
		});
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
