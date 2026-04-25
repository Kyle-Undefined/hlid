import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { BottomNav } from "#/components/nav/BottomNav";
import { Sidebar } from "#/components/nav/Sidebar";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Hliðskjálf" },
		],
		links: [
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous" as const,
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap",
			},
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "stylesheet", href: appCss },
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<head>
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
			</body>
		</html>
	);
}
