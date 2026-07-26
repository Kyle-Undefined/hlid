import { useCallback, useEffect, useRef, useState } from "react";
import { UmbodDashboard } from "#/components/forge/UmbodDashboard";
import { UmbodHooksPanel } from "#/components/forge/UmbodHooksPanel";
import { UmbodManifestPanel } from "#/components/forge/UmbodManifestPanel";
import type { HlidConfig } from "#/config";

export type UmbodSnapshot = {
	enabled: boolean;
	source?: string;
	error?: string;
	analyticsLoading?: boolean;
	analyticsError?: string;
	tools?: {
		totals?: {
			entries?: number;
			sessions?: number;
			agents?: string[];
			projects?: string[];
		};
		byTool?: {
			agent: string;
			tool: string;
			count: number;
			decisions: { allow: number; approve: number; block: number };
		}[];
	};
	rules?: {
		rules?: {
			pattern: string;
			decision: string;
			status: string;
			matchCount: number;
		}[];
		tomlSnippet?: string;
	};
};

export function UmbodSection({
	value,
	onChange,
}: {
	value: HlidConfig["umbod"];
	onChange: (next: HlidConfig["umbod"]) => void;
}) {
	const [snapshot, setSnapshot] = useState<UmbodSnapshot | null>(null);
	const loadGeneration = useRef(0);
	const load = useCallback(async (refresh = false) => {
		const generation = ++loadGeneration.current;
		const response = await fetch("/api/umbod");
		const base = (await response.json()) as UmbodSnapshot;
		if (loadGeneration.current !== generation) return;
		setSnapshot({
			...base,
			analyticsLoading: base.enabled,
		});
		if (!base.enabled) return;
		try {
			const analyticsResponse = await fetch(
				`/api/umbod?view=analytics${refresh ? "&refresh=1" : ""}`,
			);
			const analytics = (await analyticsResponse.json()) as UmbodSnapshot;
			if (loadGeneration.current !== generation) return;
			setSnapshot({
				...base,
				...analytics,
				analyticsLoading: false,
				analyticsError: analyticsResponse.ok
					? undefined
					: (analytics.error ?? "Umbod analytics failed"),
			});
		} catch (error) {
			if (loadGeneration.current !== generation) return;
			setSnapshot({
				...base,
				analyticsLoading: false,
				analyticsError: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);
	useEffect(() => {
		void load();
		return () => {
			loadGeneration.current += 1;
		};
	}, [load]);

	return (
		<div className="space-y-6">
			<UmbodManifestPanel
				value={value}
				onChange={onChange}
				snapshot={snapshot}
				onSaved={() => load(true)}
			/>
			<UmbodHooksPanel />
			<UmbodDashboard
				tools={snapshot?.tools}
				rules={snapshot?.rules}
				loading={snapshot?.analyticsLoading ?? snapshot === null}
				error={snapshot?.analyticsError}
			/>
		</div>
	);
}
