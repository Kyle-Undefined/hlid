import {
	createRootRoute,
	HeadContent,
	Scripts,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { LiveSessionSwitcherBoundary } from "#/components/chat/LiveSessionSwitcher";
import { ErrorBoundary } from "#/components/ErrorBoundary";
import { BottomNav } from "#/components/nav/BottomNav";
import { NavigationNamesProvider } from "#/components/nav/NavigationNamesContext";
import { Sidebar } from "#/components/nav/Sidebar";
import { PullToRefreshIndicator } from "#/components/PullToRefreshIndicator";
import { UpdateBanner } from "#/components/UpdateBanner";
import * as privacyStore from "#/hooks/privacyStore";
import { usePullToRefresh } from "#/hooks/usePullToRefresh";
import { useVisualViewportGuard } from "#/hooks/useVisualViewportGuard";
import {
	changedDataDomains,
	type DataRevisionSnapshot,
	getDataRevisionSnapshot,
	subscribeDataRevisionSnapshot,
} from "#/hooks/wsDataRevisionStore";
import { resolveNavigationLabels } from "#/lib/navigationNames";
import { syncPushSubscription } from "#/lib/pushNotifications";
import { shouldRevalidateRouteData } from "#/lib/routeDataRevalidation";
import { isRavenPath } from "#/lib/scrollContainers";
import { getConfig } from "#/lib/serverFns/config";
import { logClientErrorFn } from "#/lib/serverFns/logging";
import {
	serviceWorkerBuild,
	shouldReloadForServiceWorkerBuild,
} from "#/lib/serviceWorkerUpdate";
import { themeBootstrapConfig, themeBootstrapScript } from "#/lib/theme";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	loader: async () => {
		const { ui } = await getConfig();
		return {
			...themeBootstrapConfig(ui),
			navigationLabels: resolveNavigationLabels(ui.navigation_names),
		};
	},
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content:
					"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
			},
			{ title: "Hliðskjálf" },
			{ name: "theme-color", content: "#0f0f12" },
			{ name: "mobile-web-app-capable", content: "yes" },
			{ name: "apple-mobile-web-app-capable", content: "yes" },
			{
				name: "apple-mobile-web-app-status-bar-style",
				content: "black-translucent",
			},
			{ name: "apple-mobile-web-app-title", content: "Hlid" },
		],
		links: [
			{
				rel: "manifest",
				href: "/manifest.json",
				crossOrigin: "use-credentials",
			},
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "stylesheet", href: appCss },
		],
	}),
	shellComponent: RootDocument,
});

function RegisterSW() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		// True only when a worker already controls this page — i.e. this is an
		// update, not the very first install (clients.claim also fires
		// controllerchange on first install; reloading then would be a loop risk).
		const isUpdate = Boolean(navigator.serviceWorker.controller);
		let reloaded = false;
		const onControllerChange = async () => {
			if (!isUpdate || reloaded) return;
			const controller = navigator.serviceWorker.controller;
			if (!controller) return;
			const workerBuild = await serviceWorkerBuild(controller);
			if (!shouldReloadForServiceWorkerBuild(__HLID_BUILD__, workerBuild))
				return;
			reloaded = true;
			// Only an older page needs to reload after the new worker evicts its
			// cached lazy chunks. A page already served by this build stays put.
			window.location.reload();
		};
		navigator.serviceWorker.addEventListener(
			"controllerchange",
			onControllerChange,
		);

		const registration = navigator.serviceWorker.register("/sw.js");
		// Project Preview intentionally rejects service-worker registration so
		// one preview cannot install a root-scoped worker on the shared isolated
		// origin. Treat that (and other unsupported-browser failures) as a
		// non-fatal enhancement failure instead of an unhandled client error.
		void registration.then(() => syncPushSubscription()).catch(() => {});
		// Installed PWAs can sit resumed for days without a navigation, which is
		// what normally triggers the browser's sw.js update check. Re-check
		// whenever the app comes back to the foreground.
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			void registration
				.then(async (reg) => {
					// Updating and push reconciliation are independent enhancements. An
					// update-check failure must not prevent an opted-in endpoint rotation.
					await reg.update().catch(() => {});
					await syncPushSubscription();
				})
				.catch(() => {});
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onControllerChange,
			);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);
	return null;
}

function SyncPrivacyStore() {
	useEffect(() => {
		privacyStore.initFromStorage();
	}, []);
	return null;
}

function SyncServerData({ pathname }: { pathname: string }) {
	const router = useRouter();
	const revisions = useSyncExternalStore(
		subscribeDataRevisionSnapshot,
		getDataRevisionSnapshot,
		() => getDataRevisionSnapshot(),
	);
	const previousRef = useRef<DataRevisionSnapshot>(revisions);
	useEffect(() => {
		const changed = changedDataDomains(previousRef.current, revisions);
		previousRef.current = revisions;
		if (changed.length === 0) return;
		if (!shouldRevalidateRouteData(pathname, changed)) return;
		// Several writes may land together. Collapse the burst into one route read.
		const timer = setTimeout(() => void router.invalidate(), 100);
		return () => clearTimeout(timer);
	}, [pathname, revisions, router]);
	return null;
}

function AuthSessionGuard() {
	useEffect(() => {
		let active = true;
		const check = () => {
			fetch("/api/auth/status", { cache: "no-store" })
				.then((response) => (response.ok ? response.json() : null))
				.then((status: { state?: string } | null) => {
					if (active && status && status.state !== "authenticated") {
						window.location.replace("/login");
					}
				})
				.catch(() => {});
		};
		check();
		const onVisible = () => {
			if (document.visibilityState === "visible") check();
		};
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active = false;
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);
	return null;
}

function RegisterErrorLogger() {
	useEffect(() => {
		const handler = (e: PromiseRejectionEvent) => {
			const message =
				e.reason instanceof Error ? e.reason.message : String(e.reason);
			const stack = e.reason instanceof Error ? (e.reason.stack ?? null) : null;
			void logClientErrorFn({
				data: { message, componentStack: stack ?? undefined },
			}).catch(() => {});
		};
		window.addEventListener("unhandledrejection", handler);
		return () => window.removeEventListener("unhandledrejection", handler);
	}, []);
	return null;
}

function RootDocument({ children }: { children: React.ReactNode }) {
	const {
		theme,
		mobileTheme,
		customTheme,
		mobileCustomTheme,
		navigationLabels,
	} = Route.useLoaderData();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const routeKey = useRouterState({
		select: (state) => state.location.href,
	});
	const shellRef = useRef<HTMLDivElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const { pullY, isRefreshing } = usePullToRefresh(wrapperRef);
	useVisualViewportGuard(routeKey, [shellRef, wrapperRef]);
	const ravenRoute = isRavenPath(pathname);

	// The config is schema-validated and JSON-serialized by themeBootstrapScript.
	// This runs before first paint so clean origins and mobile overrides start on
	// their configured theme without waiting for a client-side config request.
	const themeInitScript = themeBootstrapScript({
		theme,
		mobileTheme,
		customTheme,
		mobileCustomTheme,
	});

	return (
		// suppressHydrationWarning: inline script mutates data-theme/className before
		// React hydrates, so server and client values intentionally differ on mobile.
		<html
			lang="en"
			data-theme={theme}
			className={theme}
			suppressHydrationWarning
		>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: theme init script built from JSON.stringify on enum values, no user input */}
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
				<HeadContent />
			</head>
			<body>
				<NavigationNamesProvider initialLabels={navigationLabels}>
					{pathname === "/login" || pathname === "/login/" ? (
						children
					) : (
						// --app-height: pinned to the visual viewport on the client by
						// useVisualViewportGuard; 100svh keeps the nav visible before hydration.
						<div
							ref={shellRef}
							className="flex h-[var(--app-height,100svh)] overflow-hidden bg-background text-foreground"
						>
							<ErrorBoundary>
								<Sidebar />
							</ErrorBoundary>
							<div
								ref={wrapperRef}
								className="flex-1 flex flex-col min-h-0 overflow-hidden relative"
							>
								<PullToRefreshIndicator
									pullY={pullY}
									isRefreshing={isRefreshing}
								/>
								<ErrorBoundary>
									<UpdateBanner />
								</ErrorBoundary>
								<main
									data-scroll-to-top="app"
									className={`flex-1 min-h-0 overscroll-y-contain ${ravenRoute ? "overflow-hidden" : "overflow-auto"}`}
								>
									{ravenRoute ? (
										<LiveSessionSwitcherBoundary routeKey={routeKey}>
											{children}
										</LiveSessionSwitcherBoundary>
									) : (
										children
									)}
								</main>
								<ErrorBoundary>
									<BottomNav />
								</ErrorBoundary>
							</div>
						</div>
					)}
				</NavigationNamesProvider>
				<Scripts />
				{pathname !== "/login" && pathname !== "/login/" && (
					<>
						<AuthSessionGuard key={pathname} />
						<RegisterSW />
						<SyncPrivacyStore />
						<SyncServerData pathname={pathname} />
						<RegisterErrorLogger />
					</>
				)}
			</body>
		</html>
	);
}
