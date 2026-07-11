import { useMemo, useState } from "react";
import type { HlidConfig } from "#/config";
import {
	type AcpAuthMethod,
	type AcpCatalogItem,
	authenticateAcpFn,
	getAcpRegistryFn,
} from "#/lib/serverFns";
import { Section } from "./fields";

export function AcpSection({
	initialCatalog,
	value,
	onChange,
}: {
	initialCatalog: AcpCatalogItem[];
	value: NonNullable<HlidConfig["acp_agents"]>;
	onChange: (value: NonNullable<HlidConfig["acp_agents"]>) => void;
}) {
	const [catalog, setCatalog] = useState(initialCatalog);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [auth, setAuth] = useState<Record<string, AcpAuthMethod[]>>({});
	const [error, setError] = useState<string | null>(null);
	const shown = useMemo(() => {
		const query = search.trim().toLowerCase();
		return query
			? catalog.filter((item) =>
					`${item.name} ${item.description}`.toLowerCase().includes(query),
				)
			: catalog;
	}, [catalog, search]);

	function toggle(item: AcpCatalogItem): void {
		const enabled = value.some((candidate) => candidate.id === item.id);
		onChange(
			enabled
				? value.filter((candidate) => candidate.id !== item.id)
				: [...value, { id: item.id }],
		);
	}

	function updateOverride(
		id: string,
		patch: Partial<NonNullable<HlidConfig["acp_agents"]>[number]>,
	): void {
		onChange(
			value.map((candidate) =>
				candidate.id === id ? { ...candidate, ...patch } : candidate,
			),
		);
	}

	async function inspect(
		item: AcpCatalogItem,
		methodId?: string,
	): Promise<void> {
		setBusy(item.id);
		setError(null);
		try {
			const result = await authenticateAcpFn({
				data: { id: item.id, methodId },
			});
			setAuth((current) => ({ ...current, [item.id]: result.authMethods }));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "ACP authentication failed",
			);
		} finally {
			setBusy(null);
		}
	}

	return (
		<Section title="Agent Client Protocol Catalog">
			<div className="px-4 py-3 space-y-2">
				<div className="flex gap-2">
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search ACP agents"
						className="min-w-0 flex-1 bg-secondary border border-border px-2.5 py-1.5 text-xs"
					/>
					<button
						type="button"
						onClick={() =>
							void getAcpRegistryFn({ data: { refresh: true } }).then(
								setCatalog,
							)
						}
						className="px-3 py-1.5 border border-border text-[10px] tracking-widest uppercase"
					>
						Refresh
					</button>
				</div>
				<p className="text-xs text-muted-foreground">
					Enabling an agent saves its configuration and requires a Hlid restart.
					Installation commands are guidance only and are never run
					automatically.
				</p>
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
			{shown.map((item) => {
				const configured = value.find((candidate) => candidate.id === item.id);
				const enabled = Boolean(configured);
				return (
					<div key={item.id} className="px-4 py-3 space-y-2">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="text-sm">
									{item.name}{" "}
									<span className="text-[9px] text-muted-foreground">
										{item.version}
									</span>
								</div>
								<p className="text-xs text-muted-foreground">
									{item.description}
								</p>
							</div>
							<button
								type="button"
								onClick={() => toggle(item)}
								className="px-2 py-1 border border-border text-[10px] uppercase"
							>
								{enabled ? "Disable" : "Enable"}
							</button>
						</div>
						<div className="text-[10px] font-mono text-muted-foreground break-all">
							{item.available
								? `${item.command} ${item.args.join(" ")} · ready`
								: item.installGuidance}
						</div>
						{configured && (
							<div className="grid sm:grid-cols-2 gap-2">
								<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
									Executable override
									<input
										value={configured.executable ?? ""}
										onChange={(event) =>
											updateOverride(item.id, {
												executable: event.target.value || undefined,
											})
										}
										placeholder={item.command || "full command path"}
										className="mt-1 w-full bg-secondary border border-border px-2 py-1 text-xs font-mono normal-case"
									/>
								</label>
								<label className="text-[9px] tracking-widest text-muted-foreground uppercase">
									Arguments override
									<input
										value={configured.args?.join(" ") ?? ""}
										onChange={(event) =>
											updateOverride(item.id, {
												args: event.target.value.trim()
													? event.target.value.trim().split(/\s+/)
													: undefined,
											})
										}
										placeholder={item.args.join(" ")}
										className="mt-1 w-full bg-secondary border border-border px-2 py-1 text-xs font-mono normal-case"
									/>
								</label>
							</div>
						)}
						{enabled && item.available && (
							<button
								type="button"
								disabled={busy === item.id}
								onClick={() => void inspect(item)}
								className="text-[10px] text-primary uppercase"
							>
								{busy === item.id ? "Checking…" : "Authentication options"}
							</button>
						)}
						{auth[item.id]?.map((method) => (
							<div
								key={method.id}
								className="border border-border p-2 text-xs space-y-1"
							>
								<div>{method.name}</div>
								{method.description && (
									<div className="text-muted-foreground">
										{method.description}
									</div>
								)}
								{method.vars && (
									<div className="font-mono text-[10px]">
										Required environment:{" "}
										{method.vars.map((variable) => variable.name).join(", ")}
									</div>
								)}
								{method.type === "terminal" && (
									<div className="font-mono text-[10px]">
										Run: {item.command} {(method.args ?? []).join(" ")}
									</div>
								)}
								{method.link && (
									<a
										href={method.link}
										target="_blank"
										rel="noreferrer"
										className="text-primary"
									>
										Open credential page
									</a>
								)}
								{!method.type && (
									<button
										type="button"
										onClick={() => void inspect(item, method.id)}
										className="text-primary uppercase"
									>
										Authenticate
									</button>
								)}
							</div>
						))}
					</div>
				);
			})}
		</Section>
	);
}
