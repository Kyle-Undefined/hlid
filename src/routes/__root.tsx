import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { BottomNav } from "#/components/nav/BottomNav";
import { Sidebar } from "#/components/nav/Sidebar";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Hlid" },
		],
		links: [{ rel: "stylesheet", href: appCss }],
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
					<main className="flex-1 overflow-auto pb-16 md:pb-0">{children}</main>
				</div>
				<BottomNav />
				<Scripts />
			</body>
		</html>
	);
}
