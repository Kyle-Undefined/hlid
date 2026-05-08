import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { ErrorFallback } from "./components/ErrorBoundary";
import { routeTree } from "./routeTree.gen";

function RouterError({ error, reset }: { error: Error; reset: () => void }) {
	return <ErrorFallback error={error} reset={reset} />;
}

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "viewport",
		defaultPreloadStaleTime: 30_000,
		defaultStaleTime: 30_000,
		defaultErrorComponent: RouterError,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
