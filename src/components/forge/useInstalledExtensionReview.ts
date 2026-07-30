import {
	type Dispatch,
	useCallback,
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
} from "react";
import { getExtensionReviewFn } from "#/lib/serverFns/extensions";
import type {
	ExtensionReview,
	ProviderExtension,
} from "#/server/extensionInventory";

function installedReviewRevision(
	extension: ProviderExtension,
	inventoryGeneration: number,
): string {
	return JSON.stringify({
		inventoryGeneration,
		id: extension.id,
		providerId: extension.providerId,
		environment: extension.environment,
		pluginId: extension.pluginId,
		marketplace: extension.marketplace,
		version: extension.version,
		installPath: extension.installPath,
		source: extension.source,
		lastUpdated: extension.lastUpdated,
		capabilities: extension.capabilities,
		components: extension.components,
		skillFiles: extension.skillFiles,
		manifestPath: extension.manifestPath,
		manifestText: extension.manifestText,
		errors: extension.errors,
		reviewHealth: extension.reviewHealth,
		cacheRecovery: extension.cacheRecovery,
	});
}

type InstalledReviewRequestState = {
	revision: string;
	requested: boolean;
	status: "idle" | "loading" | "loaded" | "error";
	review: ExtensionReview | null;
	error: string | null;
};

type InstalledReviewRequestAction =
	| { type: "revision"; revision: string; reload: boolean }
	| { type: "request"; revision: string }
	| { type: "loaded"; revision: string; review: ExtensionReview | null }
	| { type: "failed"; revision: string; error: string };

function installedReviewRequestReducer(
	state: InstalledReviewRequestState,
	action: InstalledReviewRequestAction,
): InstalledReviewRequestState {
	if (action.type === "revision") {
		if (state.revision === action.revision) return state;
		return {
			revision: action.revision,
			requested: state.requested,
			status: action.reload ? "loading" : "idle",
			review: null,
			error: null,
		};
	}
	if (action.type === "request") {
		if (
			state.revision === action.revision &&
			(state.status === "loading" || state.status === "loaded")
		) {
			return state;
		}
		return {
			revision: action.revision,
			requested: true,
			status: "loading",
			review: null,
			error: null,
		};
	}
	if (state.revision !== action.revision || state.status !== "loading") {
		return state;
	}
	return action.type === "loaded"
		? { ...state, status: "loaded", review: action.review, error: null }
		: {
				...state,
				status: "error",
				review: null,
				error: action.error,
			};
}

function useInstalledReviewLoader(
	extensionId: string,
	revision: string,
	state: InstalledReviewRequestState,
	dispatch: Dispatch<InstalledReviewRequestAction>,
	requestIdRef: { current: number },
) {
	useEffect(() => {
		if (state.revision !== revision || state.status !== "loading") return;
		const requestId = ++requestIdRef.current;
		let active = true;
		void getExtensionReviewFn({ data: { id: extensionId } }).then(
			(review) => {
				if (!active || requestId !== requestIdRef.current) return;
				dispatch({ type: "loaded", revision, review });
			},
			(cause: unknown) => {
				if (!active || requestId !== requestIdRef.current) return;
				dispatch({
					type: "failed",
					revision,
					error:
						cause instanceof Error
							? cause.message
							: "Unable to load the installed package review",
				});
			},
		);
		return () => {
			active = false;
			if (requestId === requestIdRef.current) {
				requestIdRef.current += 1;
			}
		};
	}, [
		dispatch,
		extensionId,
		requestIdRef,
		revision,
		state.revision,
		state.status,
	]);
}

export function useInstalledExtensionReview(
	extension: ProviderExtension,
	expanded: boolean,
	inventoryGeneration: number,
) {
	const revision = installedReviewRevision(extension, inventoryGeneration);
	const requestIdRef = useRef(0);
	const [state, dispatch] = useReducer(installedReviewRequestReducer, {
		revision,
		requested: false,
		status: "idle",
		review: null,
		error: null,
	});
	useLayoutEffect(() => {
		if (state.revision === revision) return;
		requestIdRef.current += 1;
		dispatch({
			type: "revision",
			revision,
			reload: expanded && state.requested,
		});
	}, [expanded, revision, state.requested, state.revision]);
	useInstalledReviewLoader(
		extension.id,
		revision,
		state,
		dispatch,
		requestIdRef,
	);
	const requestReview = useCallback(() => {
		if (
			state.revision === revision &&
			(state.status === "loading" || state.status === "loaded")
		) {
			return;
		}
		requestIdRef.current += 1;
		dispatch({ type: "request", revision });
	}, [revision, state.revision, state.status]);
	return {
		review: state.review,
		reviewing: state.status === "loading",
		reviewError: state.error,
		requestReview,
	};
}
