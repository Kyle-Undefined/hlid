import { useEffect, useMemo, useRef, useState } from "react";
import {
	searchRelicReferencesFn,
	searchVaultReferencesFn,
} from "#/lib/serverFns/vaultReferences";
import {
	type ComposerReferenceItem,
	MAX_RELIC_REFERENCES,
	MAX_VAULT_REFERENCES,
	type RelicReferenceItem,
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
	const [selectedRelics, setSelectedRelics] = useState<RelicReferenceItem[]>(
		[],
	);
	const [items, setItems] = useState<ComposerReferenceItem[]>([]);
	const [rootLabel, setRootLabel] = useState("Vault");
	const [vaultTotal, setVaultTotal] = useState(0);
	const [relicTotal, setRelicTotal] = useState(0);
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
				const vaultLimit = query.query ? 24 : 16;
				const relicLimit = query.query ? 8 : 6;
				void Promise.all([
					searchVaultReferencesFn({
						data: { query: query.query, limit: vaultLimit },
					}),
					searchRelicReferencesFn({
						data: { query: query.query, limit: relicLimit },
					}),
				])
					.then(([vaultResult, relicResult]) => {
						if (requestId.current !== currentRequest) return;
						const selectedPaths = new Set(
							selected.map((reference) => reference.relativePath),
						);
						const selectedRelicIds = new Set(
							selectedRelics.map((item) => item.id),
						);
						setItems([
							...vaultResult.items
								.filter((item) => !selectedPaths.has(item.relativePath))
								.map((item) => ({ source: "vault" as const, ...item })),
							...relicResult.items
								.filter((item) => !selectedRelicIds.has(item.id))
								.map((item) => ({ source: "relic" as const, ...item })),
						]);
						setRootLabel(vaultResult.rootLabel);
						setVaultTotal(vaultResult.total);
						setRelicTotal(relicResult.total);
						setTruncated(vaultResult.truncated || relicResult.truncated);
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
	}, [query, selected, selectedRelics]);

	const clampedIndex =
		items.length === 0 ? 0 : Math.min(selectedIndex, items.length - 1);
	const isOpen = query !== null && !forceClosed;

	function navigate(direction: 1 | -1) {
		setSelectedIndex((index) => {
			if (items.length === 0) return 0;
			return (index + direction + items.length) % items.length;
		});
	}

	function select(reference: ComposerReferenceItem) {
		if (reference.source === "vault") {
			if (selected.length >= MAX_VAULT_REFERENCES) return;
			setSelected((current) =>
				current.some((item) => item.relativePath === reference.relativePath)
					? current
					: [...current, reference],
			);
		} else {
			if (selectedRelics.length >= MAX_RELIC_REFERENCES) return;
			setSelectedRelics((current) =>
				current.some((item) => item.id === reference.id)
					? current
					: [...current, reference],
			);
		}
		setPrompt(query?.promptWithoutQuery ?? prompt);
	}

	return {
		isOpen,
		query: query?.query ?? "",
		items,
		rootLabel,
		total: vaultTotal + relicTotal,
		vaultTotal,
		relicTotal,
		truncated,
		loading,
		error,
		selectedIndex: clampedIndex,
		selected,
		selectedRelics,
		referencePaths: selected.map((reference) => reference.relativePath),
		relicAttachments: selectedRelics.map((relic) => ({
			id: relic.id,
			path: relic.path,
			filename: relic.filename,
			mime: relic.mime,
			kind: relic.kind,
			reference: "relic" as const,
		})),
		navigate,
		select,
		close: () => setForceClosed(true),
		remove: (relativePath: string) =>
			setSelected((current) =>
				current.filter((item) => item.relativePath !== relativePath),
			),
		removeRelic: (id: string) =>
			setSelectedRelics((current) => current.filter((item) => item.id !== id)),
		clear: () => {
			setSelected([]);
			setSelectedRelics([]);
		},
	};
}
