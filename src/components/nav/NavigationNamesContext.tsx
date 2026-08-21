import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	DEFAULT_NAVIGATION_NAMES_CONFIG,
	type NavigationId,
	type NavigationNamesConfig,
	resolveNavigationLabels,
} from "#/lib/navigationNames";

type NavigationLabels = Record<NavigationId, string>;
export type ViewMode = "full" | "simple";

const DEFAULT_NAVIGATION_LABELS = resolveNavigationLabels(
	DEFAULT_NAVIGATION_NAMES_CONFIG,
);

const NavigationNamesContext = createContext<{
	labels: NavigationLabels;
	viewMode: ViewMode;
	publish: (config: NavigationNamesConfig) => void;
}>({ labels: DEFAULT_NAVIGATION_LABELS, viewMode: "full", publish: () => {} });

export function NavigationNamesProvider({
	initialLabels,
	initialViewMode = "full",
	children,
}: {
	initialLabels: NavigationLabels;
	initialViewMode?: ViewMode;
	children: ReactNode;
}) {
	const [labels, setLabels] = useState(initialLabels);
	const initialLabelsKey = JSON.stringify(initialLabels);
	useEffect(
		() => setLabels(JSON.parse(initialLabelsKey) as NavigationLabels),
		[initialLabelsKey],
	);
	const publish = useCallback(
		(config: NavigationNamesConfig) =>
			setLabels(resolveNavigationLabels(config)),
		[],
	);
	const value = useMemo(
		() => ({ labels, viewMode: initialViewMode, publish }),
		[labels, initialViewMode, publish],
	);
	return (
		<NavigationNamesContext.Provider value={value}>
			{children}
		</NavigationNamesContext.Provider>
	);
}

export function useNavigationLabels(): NavigationLabels {
	return useContext(NavigationNamesContext).labels;
}

export function useViewMode(): ViewMode {
	return useContext(NavigationNamesContext).viewMode;
}

export function usePublishNavigationNames(): (
	config: NavigationNamesConfig,
) => void {
	return useContext(NavigationNamesContext).publish;
}
