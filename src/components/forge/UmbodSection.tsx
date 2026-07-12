import { useCallback, useEffect, useState } from "react";
import { UmbodDashboard } from "#/components/forge/UmbodDashboard";
import { UmbodHooksPanel } from "#/components/forge/UmbodHooksPanel";
import { UmbodManifestPanel } from "#/components/forge/UmbodManifestPanel";
import type { HlidConfig } from "#/config";

export type UmbodSnapshot = {
	enabled: boolean;
	source?: string;
	error?: string;
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
	const load = useCallback(async () => {
		const response = await fetch("/api/umbod");
		setSnapshot((await response.json()) as UmbodSnapshot);
	}, []);
	useEffect(() => void load(), [load]);

	return (
		<div className="space-y-6">
			<UmbodManifestPanel
				value={value}
				onChange={onChange}
				snapshot={snapshot}
				onSaved={load}
			/>
			<UmbodHooksPanel />
			<UmbodDashboard tools={snapshot?.tools} rules={snapshot?.rules} />
		</div>
	);
}
