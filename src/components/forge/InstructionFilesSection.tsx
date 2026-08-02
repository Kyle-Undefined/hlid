import { useEffect, useMemo, useState } from "react";
import { InstructionFilesPanel } from "#/components/instructions/InstructionFilesPanel";
import type { InstructionFileTarget } from "#/lib/instructionFileTypes";
import { getInstructionFileTargetsFn } from "#/lib/serverFns/instructionFiles";
import { Section } from "./fields";

export function InstructionFilesSection({
	vaultProvider,
	savedVaultProvider,
}: {
	/** Current form value, used to refresh when the provider selection changes. */
	vaultProvider: string;
	/** Persisted config value, used to refresh after the save/route reload. */
	savedVaultProvider?: string;
}) {
	const [targets, setTargets] = useState<InstructionFileTarget[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const refreshKey = useMemo(
		() => `${vaultProvider}\0${savedVaultProvider ?? ""}`,
		[vaultProvider, savedVaultProvider],
	);

	useEffect(() => {
		let cancelled = false;
		if (!refreshKey) return;
		setLoading(true);
		setError(null);
		void getInstructionFileTargetsFn()
			.then((next) => {
				if (!cancelled)
					setTargets(next.filter((target) => target.owner !== "agent"));
			})
			.catch((cause) => {
				if (!cancelled)
					setError(
						cause instanceof Error
							? cause.message
							: "Unable to discover instruction files",
					);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);

	function updateTarget(updated: InstructionFileTarget) {
		setTargets((current) =>
			current.map((target) => (target.id === updated.id ? updated : target)),
		);
	}

	return (
		<Section
			title="Agent Instructions"
			description="Edit vault and user-level instructions without leaving Hlið. Changes apply when a provider conversation starts or reloads."
		>
			{loading ? (
				<div className="px-4 py-4 text-xs text-muted-foreground">
					Discovering instruction files…
				</div>
			) : error ? (
				<div className="px-4 py-4 text-xs text-destructive/70">{error}</div>
			) : targets.length === 0 ? (
				<div className="px-4 py-4 text-xs text-muted-foreground">
					No instruction locations are available.
				</div>
			) : (
				<InstructionFilesPanel targets={targets} onUpdated={updateTarget} />
			)}
		</Section>
	);
}
