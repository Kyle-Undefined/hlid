import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { BottomNav } from "#/components/nav/BottomNav";
import { Sidebar } from "#/components/nav/Sidebar";
import { getConfig } from "#/config";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	loader: async () => {
		const config = await getConfig();
		return { theme: config.ui.theme, mobileTheme: config.ui.mobile_theme };
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

function RootDocument({ children }: { children: React.ReactNode }) {
	const { theme, mobileTheme } = Route.useLoaderData();

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
				<HeadContent />
			</head>
			<body>
				<div className="flex h-dvh overflow-hidden bg-background text-foreground">
					<Sidebar />
					<div className="flex-1 flex flex-col min-h-0 overflow-hidden">
						<main className="flex-1 min-h-0 overflow-auto">{children}</main>
						<BottomNav />
					</div>
				</div>
				<Scripts />
				<RegisterSW />
			</body>
		</html>
	);
}
