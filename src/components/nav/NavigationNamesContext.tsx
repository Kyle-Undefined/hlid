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

const DEFAULT_NAVIGATION_LABELS = resolveNavigationLabels(
	DEFAULT_NAVIGATION_NAMES_CONFIG,
);

const NavigationNamesContext = createContext<{
	labels: NavigationLabels;
	publish: (config: NavigationNamesConfig) => void;
}>({ labels: DEFAULT_NAVIGATION_LABELS, publish: () => {} });

export function NavigationNamesProvider({
	initialLabels,
	children,
}: {
	initialLabels: NavigationLabels;
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
	const value = useMemo(() => ({ labels, publish }), [labels, publish]);
	return (
		<NavigationNamesContext.Provider value={value}>
			{children}
		</NavigationNamesContext.Provider>
	);
}

export function useNavigationLabels(): NavigationLabels {
	return useContext(NavigationNamesContext).labels;
}

export function usePublishNavigationNames(): (
	config: NavigationNamesConfig,
) => void {
	return useContext(NavigationNamesContext).publish;
}
