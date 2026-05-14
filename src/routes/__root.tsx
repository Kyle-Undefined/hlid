import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { ErrorBoundary } from "#/components/ErrorBoundary";
import { BottomNav } from "#/components/nav/BottomNav";
import { Sidebar } from "#/components/nav/Sidebar";
import { PullToRefreshIndicator } from "#/components/PullToRefreshIndicator";
import { UpdateBanner } from "#/components/UpdateBanner";
import { getConfig } from "#/config";
import * as privacyStore from "#/hooks/privacyStore";
import { usePullToRefresh } from "#/hooks/usePullToRefresh";
import { logClientErrorFn } from "#/lib/serverFns";

import appCss from "../styles.css?url";

const getHlidToken = createServerFn({ method: "GET" }).handler(async () => {
	const { loadToken } = await import("#/lib/token");
	return loadToken();
});

export const Route = createRootRoute({
	loader: async () => {
		const [config, token] = await Promise.all([getConfig(), getHlidToken()]);
		return {
			theme: config.ui.theme,
			mobileTheme: config.ui.mobile_theme,
			token,
		};
	},
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
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
			{ rel: "manifest", href: "/manifest.json" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "stylesheet", href: appCss },
		],
	}),
	shellComponent: RootDocument,
});

function RegisterSW() {
	useEffect(() => {
		if ("serviceWorker" in navigator) {
			navigator.serviceWorker.register("/sw.js");
		}
	}, []);
	return null;
}

function SyncPrivacyStore() {
	useEffect(() => {
		privacyStore.initFromStorage();
	}, []);
	return null;
}

function RegisterErrorLogger() {
	useEffect(() => {
		const handler = (e: PromiseRejectionEvent) => {
			const message =
				e.reason instanceof Error ? e.reason.message : String(e.reason);
			const stack = e.reason instanceof Error ? (e.reason.stack ?? null) : null;
			void logClientErrorFn({ data: { message, stack } }).catch(() => {});
		};
		window.addEventListener("unhandledrejection", handler);
		return () => window.removeEventListener("unhandledrejection", handler);
	}, []);
	return null;
}

function RootDocument({ children }: { children: React.ReactNode }) {
	const { theme, mobileTheme, token } = Route.useLoaderData();
	const wrapperRef = useRef<HTMLDivElement>(null);
	const { pullY, isRefreshing } = usePullToRefresh(wrapperRef);

	// JSON.stringify on enum strings ("dark"|"tan"|"same") is XSS-safe.
	// Runs before first paint to prevent flash when mobile theme differs from desktop.
	const themeInitScript = `(function(){var t=${JSON.stringify(theme)},m=${JSON.stringify(mobileTheme ?? null)};if(m&&m!=="same"&&window.matchMedia("(pointer: coarse)").matches)t=m;document.documentElement.setAttribute("data-theme",t);document.documentElement.className=t;})();`;

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
				<meta name="hlid-token" content={token} />
				<HeadContent />
			</head>
			<body>
				<div className="flex h-dvh overflow-hidden bg-background text-foreground">
					<ErrorBoundary>
						<Sidebar />
					</ErrorBoundary>
					<div
						ref={wrapperRef}
						className="flex-1 flex flex-col min-h-0 overflow-hidden relative"
					>
						<PullToRefreshIndicator pullY={pullY} isRefreshing={isRefreshing} />
						<ErrorBoundary>
							<UpdateBanner />
						</ErrorBoundary>
						<main className="flex-1 min-h-0 overflow-auto overscroll-y-contain">
							{children}
						</main>
						<ErrorBoundary>
							<BottomNav />
						</ErrorBoundary>
					</div>
				</div>
				<Scripts />
				<RegisterSW />
				<SyncPrivacyStore />
				<RegisterErrorLogger />
			</body>
		</html>
	);
}
