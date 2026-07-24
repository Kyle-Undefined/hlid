import { useEffect, useMemo, useRef, useState } from "react";
import {
	previewVaultReferenceFn,
	previewWorkspaceReferenceFn,
	searchRelicReferencesFn,
	searchVaultReferencesFn,
	searchWorkspaceReferencesFn,
	selectWorkspaceReferenceFn,
} from "#/lib/serverFns/vaultReferences";
import {
	type ComposerReferenceItem,
	MAX_COMPOSER_REFERENCES,
	MAX_RELIC_REFERENCES,
	MAX_VAULT_REFERENCES,
	MAX_WORKSPACE_REFERENCES,
	type RelicReferenceItem,
	type VaultReferenceItem,
	type VaultReferencePreview,
	vaultReferenceQuery,
	type WorkspaceReferencePreview,
	type WorkspaceReferenceSelection,
} from "#/lib/vaultReferences";

const SEARCH_DEBOUNCE_MS = 120;
export type ComposerReferenceSource = "vault" | "workspace" | "relic";

function workspaceSelection(
	preview: WorkspaceReferencePreview,
): WorkspaceReferenceSelection {
	return {
		relativePath: preview.relativePath,
		name: preview.name,
		directory: preview.directory,
		sizeBytes: preview.sizeBytes,
		sha256: preview.sha256,
		environment: preview.environment,
		environmentLabel: preview.environmentLabel,
		previewKind: preview.previewKind,
		mime: preview.mime,
	};
}

export function useVaultReferencePicker(
	prompt: string,
	setPrompt: (value: string) => void,
	options: { workspaceAgentCwd?: string } = {},
) {
	const query = useMemo(() => vaultReferenceQuery(prompt), [prompt]);
	const workspaceAgentCwd = options.workspaceAgentCwd;
	const [selected, setSelected] = useState<VaultReferenceItem[]>([]);
	const [selectedRelics, setSelectedRelics] = useState<RelicReferenceItem[]>(
		[],
	);
	const [selectedWorkspace, setSelectedWorkspace] = useState<
		WorkspaceReferenceSelection[]
	>([]);
	const [workspacePreview, setWorkspacePreview] =
		useState<WorkspaceReferencePreview | null>(null);
	const [vaultPreview, setVaultPreview] =
		useState<VaultReferencePreview | null>(null);
	const [relicPreview, setRelicPreview] = useState<RelicReferenceItem | null>(
		null,
	);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [workspaceSelectionLoading, setWorkspaceSelectionLoading] = useState<
		string | null
	>(null);
	const [activeSource, setActiveSourceState] =
		useState<ComposerReferenceSource>("vault");
	const [items, setItems] = useState<ComposerReferenceItem[]>([]);
	const [rootLabel, setRootLabel] = useState("Vault");
	const [workspaceRootLabel, setWorkspaceRootLabel] = useState("Workspace");
	const [workspaceEnvironmentLabel, setWorkspaceEnvironmentLabel] =
		useState("Workspace");
	const [vaultTotal, setVaultTotal] = useState(0);
	const [relicTotal, setRelicTotal] = useState(0);
	const [workspaceTotal, setWorkspaceTotal] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [forceClosed, setForceClosed] = useState(false);
	const requestId = useRef(0);
	const previewRequestId = useRef(0);
	const selectionRequestId = useRef(0);
	const priorWorkspaceAgentCwd = useRef(workspaceAgentCwd);

	useEffect(() => {
		if (priorWorkspaceAgentCwd.current === workspaceAgentCwd) return;
		priorWorkspaceAgentCwd.current = workspaceAgentCwd;
		previewRequestId.current++;
		selectionRequestId.current++;
		setSelectedWorkspace([]);
		setWorkspacePreview(null);
		setVaultPreview(null);
		setRelicPreview(null);
		setPreviewLoading(false);
		setPreviewError(null);
		setWorkspaceSelectionLoading(null);
		if (!workspaceAgentCwd) setActiveSourceState("vault");
	}, [workspaceAgentCwd]);

	useEffect(() => {
		const currentRequest = ++requestId.current;
		setSelectedIndex(0);
		setForceClosed(false);
		setWorkspacePreview(null);
		setVaultPreview(null);
		setRelicPreview(null);
		setPreviewError(null);
		if (!query) {
			setItems([]);
			setLoading(false);
			setError(null);
			return;
		}
		setItems([]);
		setLoading(true);
		setError(null);
		const timer = window.setTimeout(
			() => {
				const vaultLimit = query.query ? 24 : 16;
				const relicLimit = query.query ? 8 : 6;
				const workspaceLimit = query.query ? 32 : 20;
				void Promise.all([
					searchVaultReferencesFn({
						data: { query: query.query, limit: vaultLimit },
					}),
					searchRelicReferencesFn({
						data: { query: query.query, limit: relicLimit },
					}),
					workspaceAgentCwd
						? searchWorkspaceReferencesFn({
								data: {
									agentCwd: workspaceAgentCwd,
									query: query.query,
									limit: workspaceLimit,
								},
							})
								.then((result) => ({ result, error: null }))
								.catch((cause) => ({
									result: null,
									error:
										cause instanceof Error
											? cause.message
											: "Could not search this workspace",
								}))
						: Promise.resolve({ result: null, error: null }),
				])
					.then(([vaultResult, relicResult, workspaceOutcome]) => {
						if (requestId.current !== currentRequest) return;
						const workspaceResult = workspaceOutcome.result;
						const selectedPaths = new Set(
							selected.map((reference) => reference.relativePath),
						);
						const selectedRelicIds = new Set(
							selectedRelics.map((item) => item.id),
						);
						const selectedWorkspacePaths = new Set(
							selectedWorkspace.map((item) => item.relativePath),
						);
						const sourceItems: Record<
							ComposerReferenceSource,
							ComposerReferenceItem[]
						> = {
							vault: vaultResult.items
								.filter((item) => !selectedPaths.has(item.relativePath))
								.map((item) => ({ source: "vault" as const, ...item })),
							relic: relicResult.items
								.filter((item) => !selectedRelicIds.has(item.id))
								.map((item) => ({ source: "relic" as const, ...item })),
							workspace: (workspaceResult?.items ?? [])
								.filter(
									(item) => !selectedWorkspacePaths.has(item.relativePath),
								)
								.map((item) => ({ source: "workspace" as const, ...item })),
						};
						setItems(sourceItems[activeSource]);
						setRootLabel(vaultResult.rootLabel);
						if (workspaceResult) {
							setWorkspaceRootLabel(workspaceResult.rootLabel);
							setWorkspaceEnvironmentLabel(workspaceResult.environmentLabel);
						}
						setVaultTotal(vaultResult.total);
						setRelicTotal(relicResult.total);
						setWorkspaceTotal(workspaceResult?.total ?? 0);
						setError(
							activeSource === "workspace" ? workspaceOutcome.error : null,
						);
						setTruncated(
							activeSource === "vault"
								? vaultResult.truncated
								: activeSource === "relic"
									? relicResult.truncated
									: (workspaceResult?.truncated ?? false),
						);
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
	}, [
		query,
		selected,
		selectedRelics,
		selectedWorkspace,
		activeSource,
		workspaceAgentCwd,
	]);

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
			addVaultReference(reference);
			setPrompt(query?.promptWithoutQuery ?? prompt);
		} else if (reference.source === "relic") {
			if (
				selectedRelics.length >= MAX_RELIC_REFERENCES ||
				selected.length + selectedRelics.length + selectedWorkspace.length >=
					MAX_COMPOSER_REFERENCES
			) {
				return;
			}
			setSelectedRelics((current) =>
				current.some((item) => item.id === reference.id)
					? current
					: [...current, reference],
			);
			setPrompt(query?.promptWithoutQuery ?? prompt);
		} else if (
			workspaceAgentCwd &&
			!workspaceSelectionLoading &&
			selectedWorkspace.length < MAX_WORKSPACE_REFERENCES &&
			selected.length + selectedRelics.length + selectedWorkspace.length <
				MAX_COMPOSER_REFERENCES
		) {
			const currentSelectionRequest = ++selectionRequestId.current;
			const promptAfterSelection = query?.promptWithoutQuery ?? prompt;
			setWorkspaceSelectionLoading(reference.relativePath);
			setPreviewError(null);
			void selectWorkspaceReferenceFn({
				data: {
					agentCwd: workspaceAgentCwd,
					relativePath: reference.relativePath,
				},
			})
				.then((selection) => {
					if (selectionRequestId.current === currentSelectionRequest) {
						setSelectedWorkspace((current) =>
							current.some(
								(item) => item.relativePath === selection.relativePath,
							)
								? current
								: [...current, selection],
						);
						setPrompt(promptAfterSelection);
					}
				})
				.catch((cause) => {
					if (selectionRequestId.current !== currentSelectionRequest) return;
					setPreviewError(
						cause instanceof Error
							? cause.message
							: "Could not select this workspace file",
					);
				})
				.finally(() => {
					if (selectionRequestId.current === currentSelectionRequest) {
						setWorkspaceSelectionLoading(null);
					}
				});
		}
	}

	function previewReference(reference: ComposerReferenceItem) {
		const currentPreviewRequest = ++previewRequestId.current;
		setWorkspacePreview(null);
		setVaultPreview(null);
		setRelicPreview(null);
		if (reference.source === "relic") {
			setRelicPreview(reference);
			setPreviewLoading(false);
			setPreviewError(null);
			return;
		}
		if (reference.source === "workspace" && !workspaceAgentCwd) return;
		setPreviewLoading(true);
		setPreviewError(null);
		const request =
			reference.source === "workspace"
				? previewWorkspaceReferenceFn({
						data: {
							agentCwd: workspaceAgentCwd as string,
							relativePath: reference.relativePath,
						},
					})
				: previewVaultReferenceFn({
						data: { relativePath: reference.relativePath },
					});
		void request
			.then((preview) => {
				if (previewRequestId.current !== currentPreviewRequest) return;
				if ("sha256" in preview) setWorkspacePreview(preview);
				else setVaultPreview(preview);
			})
			.catch((cause) => {
				if (previewRequestId.current !== currentPreviewRequest) return;
				setWorkspacePreview(null);
				setPreviewError(
					cause instanceof Error
						? cause.message
						: "Could not preview this workspace file",
				);
			})
			.finally(() => {
				if (previewRequestId.current === currentPreviewRequest) {
					setPreviewLoading(false);
				}
			});
	}

	function addVaultReference(reference: VaultReferenceItem) {
		setSelected((current) => {
			if (
				current.length >= MAX_VAULT_REFERENCES ||
				current.length + selectedRelics.length + selectedWorkspace.length >=
					MAX_COMPOSER_REFERENCES ||
				current.some((item) => item.relativePath === reference.relativePath)
			) {
				return current;
			}
			return [...current, reference];
		});
	}

	function confirmWorkspaceReference() {
		if (!workspacePreview) return;
		if (
			selectedWorkspace.length >= MAX_WORKSPACE_REFERENCES ||
			selected.length + selectedRelics.length + selectedWorkspace.length >=
				MAX_COMPOSER_REFERENCES
		) {
			return;
		}
		const selection = workspaceSelection(workspacePreview);
		setSelectedWorkspace((current) =>
			current.some(
				(reference) =>
					reference.relativePath === selection.relativePath &&
					reference.sha256 === selection.sha256,
			)
				? current
				: [...current, selection],
		);
		setWorkspacePreview(null);
		setPrompt(query?.promptWithoutQuery ?? prompt);
	}

	function confirmReferencePreview() {
		if (workspacePreview) {
			confirmWorkspaceReference();
			return;
		}
		if (vaultPreview) {
			addVaultReference(vaultPreview);
			setVaultPreview(null);
			setPrompt(query?.promptWithoutQuery ?? prompt);
			return;
		}
		if (relicPreview) {
			select({ source: "relic", ...relicPreview });
			setRelicPreview(null);
		}
	}

	function cancelReferencePreview() {
		previewRequestId.current++;
		setWorkspacePreview(null);
		setVaultPreview(null);
		setRelicPreview(null);
		setPreviewLoading(false);
		setPreviewError(null);
	}

	function setActiveSource(source: ComposerReferenceSource) {
		if (source === "workspace" && !workspaceAgentCwd) return;
		setActiveSourceState(source);
		setSelectedIndex(0);
		setWorkspacePreview(null);
		setVaultPreview(null);
		setRelicPreview(null);
		setPreviewError(null);
	}

	return {
		isOpen,
		query: query?.query ?? "",
		items,
		rootLabel,
		workspaceRootLabel,
		workspaceEnvironmentLabel,
		total: vaultTotal + relicTotal + workspaceTotal,
		vaultTotal,
		relicTotal,
		workspaceTotal,
		workspaceAvailable: Boolean(workspaceAgentCwd),
		activeSource,
		truncated,
		loading,
		error,
		workspacePreview,
		vaultPreview,
		relicPreview,
		referencePreviewOpen: Boolean(
			workspacePreview || vaultPreview || relicPreview,
		),
		previewLoading,
		previewError,
		workspaceSelectionLoading,
		selectedIndex: clampedIndex,
		selected,
		selectedRelics,
		selectedWorkspace,
		referencePaths: selected.map((reference) => reference.relativePath),
		workspaceReferences: selectedWorkspace.map(({ relativePath, sha256 }) => ({
			relativePath,
			sha256,
		})),
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
		previewReference,
		setActiveSource,
		confirmWorkspaceReference,
		confirmReferencePreview,
		cancelReferencePreview,
		addVaultReference,
		close: () => setForceClosed(true),
		remove: (relativePath: string) =>
			setSelected((current) =>
				current.filter((item) => item.relativePath !== relativePath),
			),
		removeRelic: (id: string) =>
			setSelectedRelics((current) => current.filter((item) => item.id !== id)),
		removeWorkspace: (relativePath: string) =>
			setSelectedWorkspace((current) =>
				current.filter((item) => item.relativePath !== relativePath),
			),
		clear: () => {
			setSelected([]);
			setSelectedRelics([]);
			setSelectedWorkspace([]);
			setWorkspacePreview(null);
			setVaultPreview(null);
			setRelicPreview(null);
			setPreviewError(null);
		},
	};
}
