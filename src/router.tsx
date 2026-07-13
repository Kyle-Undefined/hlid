import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { ErrorFallback } from "./components/ErrorBoundary";
import { installAuthRedirect } from "./lib/authClient";
import { routeTree } from "./routeTree.gen";

function RouterError({ error, reset }: { error: Error; reset: () => void }) {
	return <ErrorFallback error={error} reset={reset} />;
}

function RoutePending() {
	return (
		<div className="grid min-h-full place-items-center p-6">
			<LoaderCircle className="w-5 h-5 text-muted-foreground/40 animate-spin" />
		</div>
	);
}

function NotFound() {
	return (
		<div className="grid min-h-full place-items-center p-6 text-center">
			<div className="space-y-3">
				<h1 className="text-xl font-medium">Page not found</h1>
				<p className="text-sm text-muted-foreground">
					The requested Hlið page does not exist.
				</p>
				<a href="/" className="text-sm text-primary hover:underline">
					Return to Hlið
				</a>
			</div>
		</div>
	);
}

export function getRouter() {
	installAuthRedirect();
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "viewport",
		defaultPreloadStaleTime: 30_000,
		defaultStaleTime: 30_000,
		defaultErrorComponent: RouterError,
		defaultNotFoundComponent: NotFound,
		defaultPendingComponent: RoutePending,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
