import { useEffect, useMemo, useRef, useState } from "react";
import { searchVaultReferencesFn } from "#/lib/serverFns/vaultReferences";
import {
	MAX_VAULT_REFERENCES,
	type VaultReferenceItem,
	vaultReferenceQuery,
} from "#/lib/vaultReferences";

const SEARCH_DEBOUNCE_MS = 120;

export function useVaultReferencePicker(
	prompt: string,
	setPrompt: (value: string) => void,
) {
	const query = useMemo(() => vaultReferenceQuery(prompt), [prompt]);
	const [selected, setSelected] = useState<VaultReferenceItem[]>([]);
	const [items, setItems] = useState<VaultReferenceItem[]>([]);
	const [rootLabel, setRootLabel] = useState("Vault");
	const [total, setTotal] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [forceClosed, setForceClosed] = useState(false);
	const requestId = useRef(0);

	useEffect(() => {
		const currentRequest = ++requestId.current;
		setSelectedIndex(0);
		setForceClosed(false);
		if (!query) {
			setItems([]);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		setError(null);
		const timer = window.setTimeout(
			() => {
				void searchVaultReferencesFn({
					data: { query: query.query, limit: 48 },
				})
					.then((result) => {
						if (requestId.current !== currentRequest) return;
						const selectedPaths = new Set(
							selected.map((reference) => reference.relativePath),
						);
						setItems(
							result.items.filter(
								(item) => !selectedPaths.has(item.relativePath),
							),
						);
						setRootLabel(result.rootLabel);
						setTotal(result.total);
						setTruncated(result.truncated);
					})
					.catch((cause) => {
						if (requestId.current !== currentRequest) return;
						setItems([]);
						setError(
							cause instanceof Error
								? cause.message
								: "Could not search the vault",
						);
					})
					.finally(() => {
						if (requestId.current === currentRequest) setLoading(false);
					});
			},
			query.query ? SEARCH_DEBOUNCE_MS : 0,
		);
		return () => {
			window.clearTimeout(timer);
			if (requestId.current === currentRequest) requestId.current++;
		};
	}, [query, selected]);

	const clampedIndex =
		items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);
	const isOpen = query !== null && !forceClosed;

	function navigate(direction: 1 | -1) {
		setSelectedIndex((index) => {
			if (items.length === 0) return 0;
			return (index + direction + items.length) % items.length;
		});
	}

	function select(reference: VaultReferenceItem) {
		if (selected.length >= MAX_VAULT_REFERENCES) return;
		setSelected((current) =>
			current.some((item) => item.relativePath === reference.relativePath)
				? current
				: [...current, reference],
		);
		setPrompt(query?.promptWithoutQuery ?? prompt);
	}

	return {
		isOpen,
		query: query?.query ?? "",
		items,
		rootLabel,
		total,
		truncated,
		loading,
		error,
		selectedIndex: clampedIndex,
		selected,
		referencePaths: selected.map((reference) => reference.relativePath),
		navigate,
		select,
		close: () => setForceClosed(true),
		remove: (relativePath: string) =>
			setSelected((current) =>
				current.filter((item) => item.relativePath !== relativePath),
			),
		clear: () => setSelected([]),
	};
}
