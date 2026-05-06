import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PrivacyToggle } from "#/components/nav/PrivacyToggle";
import { FileBrowser } from "#/components/wizard/FileBrowser";
import { FolderBrowser } from "#/components/wizard/FolderBrowser";
import { RelativeFolderField } from "#/components/wizard/RelativeFolderField";
import type { HlidConfig } from "#/config";
import { DEFAULT_ATTACHMENTS_CONFIG, getConfig } from "#/config";
import type { LogCounts, LogLevel, LogRow } from "#/db";
import { useWs } from "#/hooks/useWs";
import type { ServerMessage } from "#/server/protocol";

// ─── MCP vault types ─────────────────────────────────────────────────────────

type StdioConfig = {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
};
type RemoteConfig = {
	type: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
};
type VaultMcpConfig = StdioConfig | RemoteConfig;
type VaultMcpServer = {
	name: string;
	config: VaultMcpConfig;
	disabled: boolean;
};

// ─── MCP server functions ─────────────────────────────────────────────────────

const getVaultMcpFn = createServerFn({ method: "GET" }).handler(async () => {
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const config = await getConfig();
	if (!config.vault.path) return { servers: [] as VaultMcpServer[] };

	let mcpMap: Record<string, VaultMcpConfig> = {};
	try {
		const raw = readFileSync(join(config.vault.path, ".mcp.json"), "utf8");
		mcpMap =
			(JSON.parse(raw) as { mcpServers?: Record<string, VaultMcpConfig> })
				.mcpServers ?? {};
	} catch {}

	let disabled: string[] = [];
	try {
		const raw = readFileSync(
			join(config.vault.path, ".claude", "settings.local.json"),
			"utf8",
		);
		disabled =
			(JSON.parse(raw) as { disabledMcpjsonServers?: string[] })
				.disabledMcpjsonServers ?? [];
	} catch {}

	return {
		servers: Object.entries(mcpMap).map(([name, cfg]) => ({
			name,
			config: cfg,
			disabled: disabled.includes(name),
		})),
	};
});

const writeVaultMcpFn = createServerFn({ method: "POST" })
	.inputValidator(
		(raw: unknown) => raw as { servers: Record<string, VaultMcpConfig> },
	)
	.handler(async ({ data }) => {
		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");
		writeFileSync(
			join(config.vault.path, ".mcp.json"),
			JSON.stringify({ mcpServers: data.servers }, null, 2),
			"utf8",
		);
	});

const toggleVaultMcpFn = createServerFn({ method: "POST" })
	.inputValidator((raw: unknown) => raw as { name: string; disabled: boolean })
	.handler(async ({ data }) => {
		const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const config = await getConfig();
		if (!config.vault.path) throw new Error("No vault configured");

		const settingsPath = join(
			config.vault.path,
			".claude",
			"settings.local.json",
		);
		let settings: Record<string, unknown> = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
				string,
				unknown
			>;
		} catch {}

		const disabledSet = new Set<string>(
			(settings.disabledMcpjsonServers as string[] | undefined) ?? [],
		);
		if (data.disabled) disabledSet.add(data.name);
		else disabledSet.delete(data.name);
		settings.disabledMcpjsonServers = [...disabledSet];

		mkdirSync(join(config.vault.path, ".claude"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
	});

const getLiveMcpStatusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const config = await getConfig();
		try {
			const res = await fetch(
				`http://127.0.0.1:${config.server.port + 1}/mcp-status`,
			);
			return (await res.json()) as Array<{
				name: string;
				status: string;
				scope?: string;
			}>;
		} catch {
			return [];
		}
	},
);

const getLogsFn = createServerFn({ method: "GET" })
	.inputValidator(
		(raw: unknown) => raw as { page: number; size: number; level: string },
	)
	.handler(async ({ data }) => {
		const config = await getConfig();
		const params = new URLSearchParams({
			page: String(data.page),
			size: String(data.size),
			level: data.level,
		});
		const res = await fetch(
			`http://127.0.0.1:${config.server.port + 1}/db/logs?${params}`,
		);
		if (!res.ok)
			return {
				logs: [] as LogRow[],
				total: 0,
				counts: { error: 0, warn: 0, info: 0 } as LogCounts,
			};
		return res.json() as Promise<{
			logs: LogRow[];
			total: number;
			counts: LogCounts;
		}>;
	});

const clearLogsFn = createServerFn({ method: "POST" }).handler(async () => {
	const config = await getConfig();
	const res = await fetch(
		`http://127.0.0.1:${config.server.port + 1}/db/logs`,
		{ method: "DELETE" },
	);
	if (!res.ok) throw new Error(`Failed to clear logs: ${res.status}`);
	return { ok: true };
});

const getCwdFn = createServerFn({ method: "GET" }).handler(() => process.cwd());

// ─── route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/forge")({
	loader: async () => {
		const [config, cwd] = await Promise.all([getConfig(), getCwdFn()]);
		return { ...config, cwd };
	},
	component: SettingsPage,
});

const EFFORT_OPTIONS: {
	value: HlidConfig["claude"]["effort"];
	label: string;
	desc: string;
}[] = [
	{ value: "low", label: "Low", desc: "minimal thinking, quick turnaround" },
	{ value: "medium", label: "Medium", desc: "some thinking, pretty balanced" },
	{
		value: "high",
		label: "High",
		desc: "solid reasoning, this is the default",
	},
	{ value: "xhigh", label: "X-High", desc: "goes deeper, Opus 4.7 only" },
	{
		value: "max",
		label: "Max",
		desc: "everything Claude has, Opus 4.6/4.7 only",
	},
];

const MODEL_OPTIONS = [
	{ value: "claude-opus-4-7", label: "Opus 4.7" },
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

const PERMISSION_OPTIONS: {
	value: HlidConfig["claude"]["permission_mode"];
	label: string;
	desc: string;
}[] = [
	{
		value: "default",
		label: "Ask for approval",
		desc: "Claude asks before doing anything",
	},
	{
		value: "acceptEdits",
		label: "Auto-approve edits",
		desc: "edits go through automatically, everything else still asks",
	},
	{
		value: "bypassPermissions",
		label: "Auto-approve all",
		desc: "everything goes through, no interruptions",
	},
];

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase px-1">
				{title}
			</div>
			<div className="border border-border bg-card divide-y divide-border">
				{children}
			</div>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-6 px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm text-foreground">{label}</div>
				{hint && (
					<div className="text-xs text-muted-foreground mt-0.5 break-all">
						{hint}
					</div>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function TextInput({
	value,
	onChange,
	placeholder,
	mono,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	mono?: boolean;
}) {
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={`w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors ${mono ? "font-mono text-xs" : ""}`}
		/>
	);
}

function VocabRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="px-4 py-3 space-y-1.5">
			<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
				{label}
			</div>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
				placeholder="comma separated values"
			/>
		</div>
	);
}

function PathField({
	value,
	onChange,
}: {
	value: string;
	onChange: (v: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="~/vault"
				className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
			>
				BROWSE
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
								PICK VAULT FOLDER
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FolderBrowser
							initialPath={value || undefined}
							onSelect={(path) => {
								onChange(path);
								setOpen(false);
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function FilePathField({
	value,
	onChange,
	placeholder,
	extensions,
	external,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	extensions?: string[];
	external?: boolean;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
			/>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-[10px] tracking-widest px-2 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 uppercase"
			>
				BROWSE
			</button>

			{open && (
				<div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
					<div className="w-full max-w-md bg-card border border-border shadow-2xl p-5 space-y-4">
						<div className="flex items-center justify-between">
							<div className="text-[10px] tracking-widest text-muted-foreground uppercase">
								PICK FILE
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="text-[10px] tracking-widest text-muted-foreground hover:text-foreground transition-colors uppercase"
							>
								CANCEL
							</button>
						</div>
						<FileBrowser
							initialPath={value || undefined}
							extensions={extensions}
							external={external}
							onSelect={(path) => {
								onChange(path);
								setOpen(false);
							}}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

// ─── MCP helpers ─────────────────────────────────────────────────────────────

function parseKV(text: string): Record<string, string> | undefined {
	const entries = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.includes("="))
		.map((l) => {
			const idx = l.indexOf("=");
			return [l.slice(0, idx).trim(), l.slice(idx + 1)] as [string, string];
		})
		.filter(([k]) => k.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializeKV(obj: Record<string, string> | undefined): string {
	if (!obj) return "";
	return Object.entries(obj)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
}

function parseHeader(text: string): Record<string, string> | undefined {
	const entries = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.includes(":"))
		.map((l) => {
			const idx = l.indexOf(":");
			return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [
				string,
				string,
			];
		})
		.filter(([k]) => k.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializeHeader(obj: Record<string, string> | undefined): string {
	if (!obj) return "";
	return Object.entries(obj)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
}

function KvTextarea({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder: string;
}) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={3}
			className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors resize-none"
		/>
	);
}

// ─── MCP section ─────────────────────────────────────────────────────────────

function McpSection({ vaultPath }: { vaultPath: string }) {
	const [servers, setServers] = useState<VaultMcpServer[] | null>(null);
	const [liveStatus, setLiveStatus] = useState<Map<string, string>>(new Map());
	const [cloudServers, setCloudServers] = useState<
		Array<{ name: string; status: string }>
	>([]);
	const [showAdd, setShowAdd] = useState(false);
	const [addName, setAddName] = useState("");
	const [addType, setAddType] = useState<"stdio" | "http" | "sse">("stdio");
	const [addCommand, setAddCommand] = useState("");
	const [addArgs, setAddArgs] = useState("");
	const [addUrl, setAddUrl] = useState("");
	const [addEnv, setAddEnv] = useState("");
	const [addHeaders, setAddHeaders] = useState("");
	const [opError, setOpError] = useState<string | null>(null);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [editingServer, setEditingServer] = useState<string | null>(null);
	const [editType, setEditType] = useState<"stdio" | "http" | "sse">("stdio");
	const [editCommand, setEditCommand] = useState("");
	const [editArgs, setEditArgs] = useState("");
	const [editUrl, setEditUrl] = useState("");
	const [editEnv, setEditEnv] = useState("");
	const [editHeaders, setEditHeaders] = useState("");
	const [probing, setProbing] = useState(false);

	const onMessage = useCallback((msg: ServerMessage) => {
		if (msg.type === "mcp_status") {
			setLiveStatus(new Map(msg.servers.map((s) => [s.name, s.status])));
			setCloudServers(
				msg.servers
					.filter((s) => s.scope === "claudeai")
					.map((s) => ({ name: s.name, status: s.status })),
			);
			setProbing(false);
		}
	}, []);
	const { send } = useWs(onMessage);

	useEffect(() => {
		getVaultMcpFn()
			.then((d) => setServers(d.servers))
			.catch((e) => {
				console.error("[mcp] Failed to load servers:", e);
				setServers([]);
			});
		getLiveMcpStatusFn()
			.then((statuses) => {
				setLiveStatus(new Map(statuses.map((s) => [s.name, s.status])));
				setCloudServers(
					statuses
						.filter((s) => s.scope === "claudeai")
						.map((s) => ({ name: s.name, status: s.status })),
				);
			})
			.catch((e) => console.error("[mcp] Failed to load status:", e));
	}, []);

	function statusDot(name: string): string {
		switch (liveStatus.get(name)) {
			case "connected":
				return "bg-green-500/80";
			case "needs-auth":
				return "bg-amber-400/70";
			case "failed":
				return "bg-red-500/70";
			case "pending":
				return "bg-orange-500/60 animate-pulse";
			default:
				return "bg-primary/20";
		}
	}

	function typeBadge(cfg: VaultMcpConfig): string {
		if ("url" in cfg) return cfg.type === "sse" ? "SSE" : "HTTP";
		return "STDIO";
	}

	async function handleToggle(name: string, makeDisabled: boolean) {
		setOpError(null);
		try {
			await toggleVaultMcpFn({ data: { name, disabled: makeDisabled } });
			setServers(
				(prev) =>
					prev?.map((s) =>
						s.name === name ? { ...s, disabled: makeDisabled } : s,
					) ?? null,
			);
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Toggle failed");
		}
	}

	async function handleRemove(name: string) {
		if (!servers) return;
		setOpError(null);
		try {
			const next = Object.fromEntries(
				servers.filter((s) => s.name !== name).map((s) => [s.name, s.config]),
			);
			await writeVaultMcpFn({ data: { servers: next } });
			setServers((prev) => prev?.filter((s) => s.name !== name) ?? null);
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Remove failed");
		}
	}

	function handleStartEdit(s: VaultMcpServer) {
		setEditingServer(s.name);
		setOpError(null);
		if ("url" in s.config) {
			setEditType(s.config.type === "sse" ? "sse" : "http");
			setEditUrl(s.config.url);
			setEditHeaders(serializeHeader(s.config.headers));
			setEditCommand("");
			setEditArgs("");
			setEditEnv("");
		} else {
			setEditType("stdio");
			setEditCommand(s.config.command);
			setEditArgs((s.config.args ?? []).join(", "));
			setEditEnv(serializeKV(s.config.env));
			setEditUrl("");
			setEditHeaders("");
		}
	}

	async function handleSaveEdit(name: string) {
		if (!servers) return;
		setOpError(null);
		let cfg: VaultMcpConfig;
		if (editType === "stdio") {
			if (!editCommand.trim()) {
				setOpError("Command required");
				return;
			}
			const args = editArgs
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean);
			const env = parseKV(editEnv);
			cfg = {
				command: editCommand.trim(),
				...(args.length ? { args } : {}),
				...(env ? { env } : {}),
			};
		} else {
			if (!editUrl.trim()) {
				setOpError("URL required");
				return;
			}
			const headers = parseHeader(editHeaders);
			cfg = {
				type: editType,
				url: editUrl.trim(),
				...(headers ? { headers } : {}),
			};
		}
		const next = Object.fromEntries(
			servers.map((s) => [s.name, s.name === name ? cfg : s.config]),
		);
		try {
			await writeVaultMcpFn({ data: { servers: next } });
			setServers(
				(prev) =>
					prev?.map((s) => (s.name === name ? { ...s, config: cfg } : s)) ??
					null,
			);
			setEditingServer(null);
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Save failed");
		}
	}

	async function handleAdd() {
		if (!addName.trim()) {
			setOpError("Name required");
			return;
		}
		setOpError(null);
		const current = servers ?? [];

		let cfg: VaultMcpConfig;
		if (addType === "stdio") {
			if (!addCommand.trim()) {
				setOpError("Command required");
				return;
			}
			const args = addArgs
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean);
			const env = parseKV(addEnv);
			cfg = {
				command: addCommand.trim(),
				...(args.length ? { args } : {}),
				...(env ? { env } : {}),
			};
		} else {
			if (!addUrl.trim()) {
				setOpError("URL required");
				return;
			}
			const headers = parseHeader(addHeaders);
			cfg = {
				type: addType,
				url: addUrl.trim(),
				...(headers ? { headers } : {}),
			};
		}

		const next = {
			...Object.fromEntries(current.map((s) => [s.name, s.config])),
			[addName.trim()]: cfg,
		};

		try {
			await writeVaultMcpFn({ data: { servers: next } });
			setServers([
				...current,
				{ name: addName.trim(), config: cfg, disabled: false },
			]);
			setShowAdd(false);
			setAddName("");
			setAddCommand("");
			setAddArgs("");
			setAddUrl("");
			setAddEnv("");
			setAddHeaders("");
			send({ type: "sync_mcp_list" });
		} catch (e) {
			setOpError(e instanceof Error ? e.message : "Add failed");
		}
	}

	if (!vaultPath) return null;

	return (
		<Section title="MCP">
			{servers === null && (
				<div className="px-4 py-3 text-xs text-muted-foreground/50">
					loading…
				</div>
			)}

			{servers?.map((s) =>
				editingServer === s.name ? (
					<div key={s.name} className="px-4 py-4 space-y-3">
						<div className="flex items-center justify-between">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								Edit: {s.name}
							</div>
							<select
								value={editType}
								onChange={(e) =>
									setEditType(e.target.value as "stdio" | "http" | "sse")
								}
								className="bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
							>
								<option value="stdio">stdio</option>
								<option value="http">http</option>
								<option value="sse">sse</option>
							</select>
						</div>
						{editType === "stdio" ? (
							<>
								<div className="flex gap-3">
									<div className="flex-1 space-y-1">
										<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
											Command
										</div>
										<input
											type="text"
											value={editCommand}
											onChange={(e) => setEditCommand(e.target.value)}
											placeholder="npx"
											className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
										/>
									</div>
									<div className="flex-1 space-y-1">
										<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
											Args (comma-separated)
										</div>
										<input
											type="text"
											value={editArgs}
											onChange={(e) => setEditArgs(e.target.value)}
											placeholder="-y, some-mcp-package"
											className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
										/>
									</div>
								</div>
								<div className="space-y-1">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										Env vars (KEY=value, one per line)
									</div>
									<KvTextarea
										value={editEnv}
										onChange={setEditEnv}
										placeholder={"API_KEY=abc123\nANOTHER_VAR=value"}
									/>
								</div>
							</>
						) : (
							<>
								<div className="space-y-1">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										URL
									</div>
									<input
										type="text"
										value={editUrl}
										onChange={(e) => setEditUrl(e.target.value)}
										placeholder="https://example.com/mcp"
										className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
									/>
								</div>
								<div className="space-y-1">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										Headers (KEY: value, one per line)
									</div>
									<KvTextarea
										value={editHeaders}
										onChange={setEditHeaders}
										placeholder={
											"Authorization: Bearer token123\nX-Api-Key: key"
										}
									/>
								</div>
							</>
						)}
						{opError && editingServer === s.name && (
							<div className="text-xs text-destructive">{opError}</div>
						)}
						<div className="flex gap-2 justify-end pt-1">
							<button
								type="button"
								onClick={() => {
									setEditingServer(null);
									setOpError(null);
								}}
								className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent transition-colors uppercase"
							>
								CANCEL
							</button>
							<button
								type="button"
								onClick={() => void handleSaveEdit(s.name)}
								className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase"
							>
								SAVE
							</button>
						</div>
					</div>
				) : (
					<div key={s.name} className="flex items-center gap-3 px-4 py-3">
						<span
							className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.name)}`}
						/>
						<span
							className={`flex-1 text-sm min-w-0 truncate ${s.disabled ? "text-muted-foreground line-through" : "text-foreground"}`}
						>
							{s.name}
						</span>
						<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
							{typeBadge(s.config)}
						</span>
						<button
							type="button"
							onClick={() => handleStartEdit(s)}
							className="text-[9px] tracking-widest text-muted-foreground/30 hover:text-foreground uppercase transition-colors shrink-0"
						>
							edit
						</button>
						<label className="flex items-center gap-1.5 cursor-pointer shrink-0">
							<input
								type="checkbox"
								checked={!s.disabled}
								onChange={() => handleToggle(s.name, !s.disabled)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{s.disabled ? "off" : "on"}
							</span>
						</label>
						{confirmRemove === s.name ? (
							<div className="flex items-center gap-2 shrink-0">
								<span className="text-[9px] text-muted-foreground/50">
									remove?
								</span>
								<button
									type="button"
									onClick={() => {
										setConfirmRemove(null);
										void handleRemove(s.name);
									}}
									className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
								>
									confirm
								</button>
								<button
									type="button"
									onClick={() => setConfirmRemove(null)}
									className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
								>
									cancel
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setConfirmRemove(s.name)}
								className="text-muted-foreground/30 hover:text-destructive transition-colors text-base shrink-0 leading-none"
							>
								×
							</button>
						)}
					</div>
				),
			)}

			{cloudServers.map((s) => (
				<div
					key={s.name}
					className="flex items-center gap-3 px-4 py-3 opacity-60"
				>
					<span
						className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot(s.name)}`}
					/>
					<span className="flex-1 text-sm min-w-0 truncate text-foreground">
						{s.name.startsWith("claude.ai ")
							? s.name.slice("claude.ai ".length)
							: s.name}
					</span>
					<span className="text-[9px] tracking-widest text-muted-foreground/40 uppercase shrink-0">
						claude.ai
					</span>
				</div>
			))}

			{servers !== null && !showAdd && (
				<div className="px-4 py-3">
					<button
						type="button"
						onClick={() => setShowAdd(true)}
						className="text-[10px] tracking-widest text-muted-foreground/40 hover:text-foreground transition-colors uppercase"
					>
						+ ADD SERVER
					</button>
				</div>
			)}

			{showAdd && (
				<div className="px-4 py-4 space-y-3">
					<div className="flex gap-3">
						<div className="flex-1 space-y-1">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								Name
							</div>
							<input
								type="text"
								value={addName}
								onChange={(e) => setAddName(e.target.value)}
								placeholder="my-server"
								className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
							/>
						</div>
						<div className="space-y-1">
							<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
								Type
							</div>
							<select
								value={addType}
								onChange={(e) =>
									setAddType(e.target.value as "stdio" | "http" | "sse")
								}
								className="bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
							>
								<option value="stdio">stdio</option>
								<option value="http">http</option>
								<option value="sse">sse</option>
							</select>
						</div>
					</div>

					{addType === "stdio" ? (
						<>
							<div className="flex gap-3">
								<div className="flex-1 space-y-1">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										Command
									</div>
									<input
										type="text"
										value={addCommand}
										onChange={(e) => setAddCommand(e.target.value)}
										placeholder="npx"
										className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
									/>
								</div>
								<div className="flex-1 space-y-1">
									<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
										Args (comma-separated)
									</div>
									<input
										type="text"
										value={addArgs}
										onChange={(e) => setAddArgs(e.target.value)}
										placeholder="-y, some-mcp-package"
										className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
									/>
								</div>
							</div>
							<div className="space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
									Env vars (KEY=value, one per line)
								</div>
								<KvTextarea
									value={addEnv}
									onChange={setAddEnv}
									placeholder={"API_KEY=abc123\nANOTHER_VAR=value"}
								/>
							</div>
						</>
					) : (
						<>
							<div className="space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
									URL
								</div>
								<input
									type="text"
									value={addUrl}
									onChange={(e) => setAddUrl(e.target.value)}
									placeholder="https://example.com/mcp"
									className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
								/>
							</div>
							<div className="space-y-1">
								<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
									Headers (KEY: value, one per line)
								</div>
								<KvTextarea
									value={addHeaders}
									onChange={setAddHeaders}
									placeholder={"Authorization: Bearer token123\nX-Api-Key: key"}
								/>
							</div>
						</>
					)}

					{opError && <div className="text-xs text-destructive">{opError}</div>}

					<div className="flex gap-2 justify-end pt-1">
						<button
							type="button"
							onClick={() => {
								setShowAdd(false);
								setOpError(null);
							}}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent transition-colors uppercase"
						>
							CANCEL
						</button>
						<button
							type="button"
							onClick={handleAdd}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase"
						>
							ADD
						</button>
					</div>
				</div>
			)}

			{opError && !showAdd && (
				<div className="px-4 py-2 text-xs text-destructive">{opError}</div>
			)}

			<div className="px-4 py-3 flex items-center justify-between gap-4 border-t border-border">
				<div className="text-[9px] text-muted-foreground/30 leading-relaxed">
					changes take effect on next session · cloud MCPs managed on claude.ai
					<br />
					use <span className="text-muted-foreground/50">check MCPs</span> to
					validate configs, runs a quick SDK query
				</div>
				<button
					type="button"
					disabled={probing}
					onClick={() => {
						setProbing(true);
						send({ type: "probe_mcp" });
					}}
					className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed uppercase transition-colors shrink-0"
				>
					{probing ? "checking…" : "check MCPs"}
				</button>
			</div>
		</Section>
	);
}

// ─── event log ───────────────────────────────────────────────────────────────

const LOG_PAGE_SIZE = 50;
const LEVEL_TABS = ["all", "error", "warn", "info"] as const;
type LevelTab = (typeof LEVEL_TABS)[number];

const LEVEL_COLORS: Record<LogLevel, string> = {
	error: "text-destructive",
	warn: "text-yellow-500",
	info: "text-muted-foreground",
};

function LogEntryRow({ entry }: { entry: LogRow }) {
	const [expanded, setExpanded] = useState(false);
	const d = new Date(entry.timestamp * 1000);
	const tsShort = d.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const tsFull = d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return (
		<div className="border-b border-border last:border-0">
			<button
				type="button"
				onClick={() => entry.detail != null && setExpanded((p) => !p)}
				className={`w-full flex items-start gap-3 px-4 py-2.5 text-left ${entry.detail != null ? "hover:bg-accent/20 cursor-pointer" : "cursor-default"} transition-colors`}
			>
				<span className="text-[9px] tabular-nums text-muted-foreground/40 shrink-0 pt-0.5 w-16 sm:w-28">
					<span className="sm:hidden">{tsShort}</span>
					<span className="hidden sm:inline">{tsFull}</span>
				</span>
				<span
					className={`text-[9px] tracking-widest uppercase shrink-0 w-10 pt-0.5 ${LEVEL_COLORS[entry.level]}`}
				>
					{entry.level}
				</span>
				<span className="hidden sm:inline text-[9px] tracking-widest text-muted-foreground/50 uppercase shrink-0 w-14 pt-0.5">
					{entry.source}
				</span>
				<span className="text-xs text-foreground/80 flex-1 min-w-0 break-words">
					{entry.message}
				</span>
				{entry.detail != null && (
					<span className="text-[9px] text-muted-foreground/30 shrink-0">
						{expanded ? "▲" : "▼"}
					</span>
				)}
			</button>
			{expanded && entry.detail != null && (
				<div className="px-4 pb-2.5">
					<pre className="text-[10px] font-mono text-muted-foreground bg-secondary p-2 overflow-x-auto whitespace-pre-wrap break-all">
						{(() => {
							try {
								return JSON.stringify(
									JSON.parse(entry.detail as string),
									null,
									2,
								);
							} catch {
								return entry.detail;
							}
						})()}
					</pre>
				</div>
			)}
		</div>
	);
}

function EventLogSection() {
	const [activeTab, setActiveTab] = useState<LevelTab>("all");
	const [page, setPage] = useState(1);
	const [data, setData] = useState<{
		logs: LogRow[];
		total: number;
		counts: LogCounts;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [clearConfirming, setClearConfirming] = useState(false);

	const load = useCallback(async (tab: LevelTab, p: number) => {
		setLoading(true);
		try {
			const result = await getLogsFn({
				data: { page: p, size: LOG_PAGE_SIZE, level: tab },
			});
			setData(result);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(activeTab, page);
	}, [load, activeTab, page]);

	function handleTabChange(tab: LevelTab) {
		setActiveTab(tab);
		setPage(1);
	}

	async function handleClear() {
		try {
			await clearLogsFn();
		} catch (e) {
			console.error("[logs] clear failed:", e);
		}
		setClearConfirming(false);
		setPage(1);
		void load(activeTab, 1);
	}

	const total = data?.total ?? 0;
	const counts = data?.counts ?? { error: 0, warn: 0, info: 0 };
	const totalPages = Math.ceil(total / LOG_PAGE_SIZE);

	return (
		<Section title="Event Log">
			<div className="border-b border-border">
				<div className="flex items-center justify-between px-4 py-2">
					<div className="flex items-center gap-3">
						{LEVEL_TABS.map((tab) => {
							const count =
								tab === "all"
									? counts.error + counts.warn + counts.info
									: (counts[tab as LogLevel] ?? 0);
							return (
								<button
									key={tab}
									type="button"
									onClick={() => handleTabChange(tab)}
									className={`text-[9px] tracking-widest uppercase transition-colors ${
										activeTab === tab
											? "text-foreground"
											: "text-muted-foreground/40 hover:text-muted-foreground/70"
									}`}
								>
									{tab}
									{count > 0 && (
										<span className="ml-1 tabular-nums text-muted-foreground/40">
											{count}
										</span>
									)}
								</button>
							);
						})}
					</div>
					{clearConfirming ? (
						<div className="flex items-center gap-2">
							<span className="text-[9px] text-muted-foreground/50">
								clear all?
							</span>
							<button
								type="button"
								onClick={handleClear}
								className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
							>
								confirm
							</button>
							<button
								type="button"
								onClick={() => setClearConfirming(false)}
								className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
							>
								cancel
							</button>
						</div>
					) : total > 0 ? (
						<button
							type="button"
							onClick={() => setClearConfirming(true)}
							className="text-[8px] tracking-widest text-muted-foreground/30 hover:text-muted-foreground/60 uppercase transition-colors"
						>
							clear
						</button>
					) : null}
				</div>
			</div>

			{loading ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/50">
					loading…
				</div>
			) : !data || data.logs.length === 0 ? (
				<div className="px-4 py-6 text-center text-[9px] tracking-widest text-muted-foreground/30">
					no logs
				</div>
			) : (
				data.logs.map((entry) => <LogEntryRow key={entry.id} entry={entry} />)
			)}

			{totalPages > 1 && (
				<div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
					<button
						type="button"
						disabled={page <= 1 || loading}
						onClick={() => setPage((p) => p - 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						← prev
					</button>
					<span className="text-[9px] tabular-nums text-muted-foreground/30">
						{page} / {totalPages}
					</span>
					<button
						type="button"
						disabled={page >= totalPages || loading}
						onClick={() => setPage((p) => p + 1)}
						className="text-[9px] tracking-widest text-muted-foreground/40 hover:text-foreground disabled:opacity-20 uppercase transition-colors"
					>
						next →
					</button>
				</div>
			)}
		</Section>
	);
}

// ─── updates ──────────────────────────────────────────────────────────────────

type UpdateStatus = {
	current: string;
	latest: string | null;
	available: boolean;
	lastCheckedAt: number;
	error?: string;
};

type ApplyState =
	| { phase: "idle" }
	| { phase: "checking" }
	| { phase: "downloading" }
	| { phase: "downloaded"; stagedExe: string; targetVersion: string }
	| { phase: "launching"; targetVersion: string }
	| { phase: "error"; message: string };

function relativeTime(epochMs: number): string {
	if (!epochMs) return "never";
	const diff = Date.now() - epochMs;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function UpdatesSection() {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [state, setState] = useState<ApplyState>({ phase: "idle" });

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/updates");
			const j = (await res.json()) as { ok: boolean; data?: UpdateStatus };
			if (j.ok && j.data) setStatus(j.data);
		} catch (e) {
			console.error("[updates] fetch failed:", e);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// While launching, hit /api/version every 1.5s. When the version response
	// changes (new instance is up after the staged exe took canonical), reload
	// so dad sees a fresh page on the new build.
	useEffect(() => {
		if (state.phase !== "launching") return;
		const startVersion = status?.current ?? null;
		const id = setInterval(async () => {
			try {
				const r = await fetch("/api/version", { cache: "no-store" });
				if (!r.ok) return;
				const j = (await r.json()) as { version?: string };
				if (j.version && j.version !== startVersion) {
					window.location.reload();
				}
			} catch {
				// Brief disconnect mid-restart is expected; keep polling.
			}
		}, 1500);
		return () => clearInterval(id);
	}, [state.phase, status?.current]);

	async function postAction(
		action: "check" | "download" | "apply",
		extra?: Record<string, unknown>,
	): Promise<{ ok: boolean; data?: unknown; error?: string }> {
		const res = await fetch("/api/updates", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, ...(extra ?? {}) }),
		});
		return (await res.json()) as {
			ok: boolean;
			data?: unknown;
			error?: string;
		};
	}

	async function checkNow() {
		setState({ phase: "checking" });
		const r = await postAction("check").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (r.ok && r.data) {
			setStatus(r.data as UpdateStatus);
			setState({ phase: "idle" });
		} else {
			setState({ phase: "error", message: r.error ?? "check failed" });
		}
	}

	// Download + checksum-verify the new exe, then surface a "Launch" button.
	// We don't auto-launch because Windows SmartScreen only renders its
	// "More info → Run anyway" prompt when the launch comes from an
	// interactive shell context. Routing the launch through `explorer.exe
	// <stagedExe>` (server-side) on a user click is what gets the prompt
	// in front of the user; a programmatic spawn is silently suppressed
	// for unsigned binaries with no SmartScreen reputation.
	async function downloadOnly() {
		setState({ phase: "downloading" });
		const dl = await postAction("download").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!dl.ok) {
			setState({ phase: "error", message: dl.error ?? "download failed" });
			return;
		}
		const data = dl.data as { stagedExe: string; version: string } | undefined;
		if (!data?.stagedExe) {
			setState({ phase: "error", message: "no staged exe path returned" });
			return;
		}
		setState({
			phase: "downloaded",
			stagedExe: data.stagedExe,
			targetVersion: data.version,
		});
	}

	async function launchStaged(stagedExe: string, targetVersion: string) {
		setState({ phase: "launching", targetVersion });
		const ap = await postAction("apply", { stagedExe }).catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!ap.ok) {
			setState({ phase: "error", message: ap.error ?? "launch failed" });
		}
		// On success the staged exe's maybeSelfInstall path will POST a
		// shutdown to the running canonical; the polling effect above
		// takes over and reloads when the new version answers.
	}

	const current = status?.current ?? "—";
	const latest = status?.latest;
	const available = status?.available ?? false;

	return (
		<Section title="Updates">
			<Field
				label="Version"
				hint={
					status === null
						? "loading…"
						: available && latest
							? `update available: v${latest}`
							: "you're on the latest version"
				}
			>
				<span className="text-xs font-mono text-muted-foreground">
					v{current}
					{available && latest ? (
						<>
							{" "}
							<span className="text-foreground">→ v{latest}</span>
						</>
					) : null}
				</span>
			</Field>

			<Field
				label="Check for updates"
				hint={
					status?.lastCheckedAt
						? `last checked ${relativeTime(status.lastCheckedAt)}`
						: "never checked"
				}
			>
				<button
					type="button"
					onClick={() => {
						void checkNow();
					}}
					disabled={state.phase !== "idle" && state.phase !== "error"}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
				>
					{state.phase === "checking" ? "CHECKING…" : "CHECK"}
				</button>
			</Field>

			{available && state.phase !== "downloaded" && (
				<Field label="Download update" hint="fetches and verifies the new exe">
					<button
						type="button"
						onClick={() => {
							void downloadOnly();
						}}
						disabled={state.phase !== "idle" && state.phase !== "error"}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-40"
					>
						{state.phase === "downloading" ? "DOWNLOADING…" : "DOWNLOAD"}
					</button>
				</Field>
			)}

			{state.phase === "downloaded" && (
				<Field
					label="Launch installer"
					hint="opens the new exe via Windows shell — accept the SmartScreen prompt to install"
				>
					<button
						type="button"
						onClick={() => {
							void launchStaged(state.stagedExe, state.targetVersion);
						}}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase"
					>
						LAUNCH v{state.targetVersion}
					</button>
				</Field>
			)}

			{state.phase === "launching" && (
				<div className="px-4 py-2 text-xs text-muted-foreground">
					launching v{state.targetVersion} — accept the SmartScreen prompt if it
					appears. page will reload when the new version is up.
				</div>
			)}

			{state.phase === "error" && (
				<div className="px-4 py-2 text-xs text-destructive/80">
					{state.message}
				</div>
			)}
			{status?.error && state.phase !== "error" && (
				<div className="px-4 py-2 text-xs text-muted-foreground/70">
					last check: {status.error}
				</div>
			)}
		</Section>
	);
}

// ─── system / lifecycle ───────────────────────────────────────────────────────

type InstallPaths = {
	exe: string;
	dir: string;
	canonical_exe: string;
	canonical_dir: string;
	is_canonical: boolean;
};

type LifecycleState = {
	enabled: boolean;
	supported: boolean;
	path?: string;
	install?: InstallPaths;
};

function SystemSection() {
	const [autostart, setAutostart] = useState<LifecycleState | null>(null);
	const [busy, setBusy] = useState<
		null | "toggle" | "shutdown" | "open_install_dir"
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmShutdown, setConfirmShutdown] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/lifecycle");
			const j = (await res.json()) as {
				ok: boolean;
				data?: LifecycleState;
			};
			if (j.ok && j.data) setAutostart(j.data);
		} catch (e) {
			console.error("[lifecycle] Failed to fetch status:", e);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function post(
		action: "install" | "uninstall" | "shutdown" | "open_install_dir",
	) {
		const res = await fetch("/api/lifecycle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
		return (await res.json()) as { ok: boolean; error?: string };
	}

	async function openInstallDir() {
		setError(null);
		setBusy("open_install_dir");
		const r = await post("open_install_dir").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!r.ok) setError(r.error ?? "Failed to open folder");
		setBusy(null);
	}

	async function toggleAutostart() {
		if (!autostart?.supported) return;
		setError(null);
		setBusy("toggle");
		const action = autostart.enabled ? "uninstall" : "install";
		const r = await post(action).catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!r.ok) setError(r.error ?? "Failed");
		await refresh();
		setBusy(null);
	}

	async function doShutdown() {
		setError(null);
		setBusy("shutdown");
		const r = await post("shutdown").catch(
			(e) => ({ ok: false, error: String(e) }) as const,
		);
		if (!r.ok) {
			setError(r.error ?? "Shutdown failed");
			setBusy(null);
		}
	}

	const supported = autostart?.supported ?? false;
	const enabled = autostart?.enabled ?? false;
	const install = autostart?.install;

	return (
		<Section title="System">
			{install && (
				<Field label="Install location" hint={install.dir}>
					<button
						type="button"
						onClick={() => {
							void openInstallDir();
						}}
						disabled={busy === "open_install_dir" || !supported}
						title={
							supported ? "open install folder in Explorer" : "Windows only"
						}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors uppercase disabled:opacity-40"
					>
						{busy === "open_install_dir" ? "OPENING…" : "OPEN"}
					</button>
				</Field>
			)}
			<Field
				label="Launch on login"
				hint={
					autostart === null
						? "checking…"
						: !supported
							? "Windows only"
							: enabled
								? "starts in background when you sign in"
								: "off; Hlid won't start automatically"
				}
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={enabled}
						disabled={!supported || busy === "toggle"}
						onChange={() => {
							void toggleAutostart();
						}}
						className="accent-primary w-3.5 h-3.5"
					/>
					<span className="text-xs text-muted-foreground">
						{enabled ? "on" : "off"}
					</span>
				</label>
			</Field>
			<Field label="Shutdown" hint="exit Hlid completely">
				{confirmShutdown ? (
					<div className="flex items-center gap-2 shrink-0">
						<span className="text-[9px] text-muted-foreground/50">
							shutdown?
						</span>
						<button
							type="button"
							onClick={() => {
								setConfirmShutdown(false);
								void doShutdown();
							}}
							className="text-[9px] tracking-widest text-destructive/60 hover:text-destructive uppercase transition-colors"
						>
							confirm
						</button>
						<button
							type="button"
							onClick={() => setConfirmShutdown(false)}
							className="text-[9px] tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 uppercase transition-colors"
						>
							cancel
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setConfirmShutdown(true)}
						disabled={busy !== null}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-destructive/40 text-destructive/80 hover:text-destructive hover:bg-destructive/10 transition-colors uppercase disabled:opacity-40"
					>
						{busy === "shutdown" ? "STOPPING…" : "SHUTDOWN"}
					</button>
				)}
			</Field>
			{error && (
				<div className="px-4 py-2 text-xs text-destructive/80">{error}</div>
			)}
		</Section>
	);
}

// ─── tailscale ────────────────────────────────────────────────────────────────

type TailscaleStatus = {
	installed: boolean;
	state:
		| "Running"
		| "NeedsLogin"
		| "Stopped"
		| "Starting"
		| "NoState"
		| "Unknown"
		| null;
	magicDNS: string | null;
	ips: string[];
	error?: string;
};

function tailscaleSetupPrompt(cwd: string) {
	return `Help me set up Tailscale for hlid. My current working directory is \`${cwd}\`. Detect if Tailscale is installed and walk me through install for my OS if not. Then help me run \`tailscale up\` to authenticate. Ask me where to store the TLS certs, then run \`tailscale cert <my-magicdns-hostname>\` there. Update tls_cert_path and tls_key_path in hlid.config.toml. When done, tell me to restart hlid.`;
}

function StatusDot({ ok }: { ok: boolean | null }) {
	const cls =
		ok === true
			? "bg-emerald-500"
			: ok === false
				? "bg-destructive"
				: "bg-muted-foreground/40";
	return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

function TailscaleSection({
	tlsProxyPort,
	setTlsProxyPort,
	tlsCertPath,
	setTlsCertPath,
	tlsKeyPath,
	setTlsKeyPath,
	localNetworkAccess,
	cwd,
}: {
	tlsProxyPort: string;
	setTlsProxyPort: (v: string) => void;
	tlsCertPath: string;
	setTlsCertPath: (v: string) => void;
	tlsKeyPath: string;
	setTlsKeyPath: (v: string) => void;
	localNetworkAccess: boolean;
	cwd: string;
}) {
	const router = useRouter();
	const [status, setStatus] = useState<TailscaleStatus | null>(null);
	const [checking, setChecking] = useState(false);

	const refresh = useCallback(async () => {
		setChecking(true);
		try {
			const res = await fetch("/api/tailscale");
			if (res.ok) setStatus((await res.json()) as TailscaleStatus);
		} catch (e) {
			console.error("[tailscale] Failed to fetch status:", e);
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const installed = status?.installed ?? null;
	const authed = status?.state === "Running" ? true : status ? false : null;
	const certsConfigured = Boolean(tlsCertPath && tlsKeyPath);
	const reachable =
		status?.state === "Running" &&
		status.magicDNS &&
		certsConfigured &&
		localNetworkAccess;
	const url = reachable
		? `https://${status.magicDNS}:${Number(tlsProxyPort) || 3443}`
		: null;

	function startSetup() {
		router.navigate({
			to: "/raven",
			search: { prompt: tailscaleSetupPrompt(cwd) },
		});
	}

	return (
		<Section title="Tailscale">
			<Field label="Installed">
				<div className="flex items-center gap-3">
					<StatusDot ok={installed} />
					<span className="text-xs text-muted-foreground">
						{installed === null
							? "checking…"
							: installed
								? "yes"
								: "not detected"}
					</span>
					{installed === false && (
						<button
							type="button"
							onClick={() =>
								window.open(
									"https://tailscale.com/download",
									"_blank",
									"noopener,noreferrer",
								)
							}
							className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
						>
							DOWNLOAD
						</button>
					)}
					<button
						type="button"
						onClick={() => void refresh()}
						disabled={checking}
						className="text-[10px] tracking-widest px-2 py-1 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase disabled:opacity-40"
					>
						{checking ? "…" : "RECHECK"}
					</button>
				</div>
			</Field>
			{installed && (
				<Field
					label="Authenticated"
					hint={
						status?.state === "NeedsLogin"
							? "run `tailscale up` to log in"
							: status?.state && status.state !== "Running"
								? `state: ${status.state}`
								: undefined
					}
				>
					<div className="flex items-center gap-3">
						<StatusDot ok={authed} />
						<span className="text-xs text-muted-foreground">
							{authed === null ? "?" : authed ? "yes" : "no"}
						</span>
					</div>
				</Field>
			)}
			{status?.magicDNS && (
				<div className="px-4 py-3 space-y-1.5">
					<div className="text-sm text-foreground">MagicDNS</div>
					<div className="text-xs font-mono text-muted-foreground break-all">
						{status.magicDNS}
					</div>
				</div>
			)}
			<Field label="TLS Cert Path">
				<FilePathField
					value={tlsCertPath}
					onChange={setTlsCertPath}
					placeholder="/path/to/cert.pem"
					extensions={[".pem", ".crt", ".cer"]}
					external
				/>
			</Field>
			<Field label="TLS Key Path">
				<FilePathField
					value={tlsKeyPath}
					onChange={setTlsKeyPath}
					placeholder="/path/to/key.pem"
					extensions={[".pem", ".key"]}
					external
				/>
			</Field>
			<Field label="TLS Proxy Port">
				<TextInput
					value={tlsProxyPort}
					onChange={setTlsProxyPort}
					placeholder="3443"
					mono
				/>
			</Field>
			{url && (
				<div className="px-4 py-3 space-y-1.5">
					<div className="text-sm text-foreground">Reachable at</div>
					<div className="text-xs text-muted-foreground">
						open this URL from any device on your tailnet
					</div>
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="block text-xs font-mono text-primary hover:underline break-all pt-1"
					>
						{url}
					</a>
				</div>
			)}
			<Field
				label="Set up with Claude"
				hint="opens chat with a setup prompt, Claude walks you through install, auth, and cert generation"
			>
				<button
					type="button"
					onClick={startSetup}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
				>
					START
				</button>
			</Field>
			{status?.error && (
				<div className="px-4 py-2 text-xs text-destructive/80">
					{status.error}
				</div>
			)}
		</Section>
	);
}

// ─── page ─────────────────────────────────────────────────────────────────────

function SettingsPage() {
	const initial = Route.useLoaderData();
	const { send } = useWs();

	const [vaultName, setVaultName] = useState(initial.vault.name);
	const [vaultPath, setVaultPath] = useState(initial.vault.path);
	const [vaultStyle, setVaultStyle] = useState<"para" | "wiki">(
		initial.vault.style ?? "para",
	);
	const [inbox, setInbox] = useState(initial.vault.inbox ?? "");
	const [projects, setProjects] = useState(initial.vault.projects ?? "");
	const [areas, setAreas] = useState(initial.vault.areas ?? "");
	const [resources, setResources] = useState(initial.vault.resources ?? "");
	const [archive, setArchive] = useState(initial.vault.archive ?? "");
	const [raw, setRaw] = useState(initial.vault.raw ?? "");
	const [wikiFolder, setWikiFolder] = useState(initial.vault.wiki_folder ?? "");
	const [outputs, setOutputs] = useState(initial.vault.outputs ?? "");
	const [skills, setSkills] = useState(initial.vault.skills ?? "");
	const [memory, setMemory] = useState(initial.vault.memory ?? "");
	const [model, setModel] = useState(initial.claude.model);
	const [effort, setEffort] = useState(initial.claude.effort);
	const [maxTurns, setMaxTurns] = useState(
		initial.claude.max_turns !== undefined
			? String(initial.claude.max_turns)
			: "",
	);
	const [permissionMode, setPermissionMode] = useState(
		initial.claude.permission_mode,
	);
	const [turnRecaps, setTurnRecaps] = useState(
		initial.claude.turn_recaps ?? true,
	);
	const [port, setPort] = useState(String(initial.server.port));
	const [tlsCertPath, setTlsCertPath] = useState(
		initial.server.tls_cert_path ?? "",
	);
	const [tlsKeyPath, setTlsKeyPath] = useState(
		initial.server.tls_key_path ?? "",
	);
	const [tlsProxyPort, setTlsProxyPort] = useState(
		initial.server.tls_proxy_port != null
			? String(initial.server.tls_proxy_port)
			: "",
	);
	const [localNetworkAccess, setLocalNetworkAccess] = useState(
		initial.server.local_network_access ?? false,
	);
	const [allowExternalAgents, setAllowExternalAgents] = useState(
		initial.server.allow_external_agents ?? false,
	);
	const [enterToSubmit, setEnterToSubmit] = useState(
		initial.ui.enter_to_submit,
	);
	const [hideSkillsIndex, setHideSkillsIndex] = useState(
		initial.ui.hide_skills_index,
	);
	const [theme, setTheme] = useState<"dark" | "tan">(initial.ui.theme);
	const [mobileTheme, setMobileTheme] = useState<"dark" | "tan" | "same">(
		initial.ui.mobile_theme ?? "same",
	);
	const [vocabActive, setVocabActive] = useState(
		initial.status_vocabulary.active.join(", "),
	);
	const [vocabPlanning, setVocabPlanning] = useState(
		initial.status_vocabulary.planning.join(", "),
	);
	const [vocabDone, setVocabDone] = useState(
		initial.status_vocabulary.done.join(", "),
	);

	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const router = useRouter();

	useEffect(() => {
		const isMobile = window.matchMedia("(pointer: coarse)").matches;
		const effective = isMobile && mobileTheme !== "same" ? mobileTheme : theme;
		document.documentElement.setAttribute("data-theme", effective);
		document.documentElement.className = effective;
	}, [theme, mobileTheme]);

	async function save() {
		setSaving(true);
		setError(null);
		setSaved(false);

		const config: HlidConfig = {
			vault: {
				name: vaultName,
				path: vaultPath,
				style: vaultStyle,
				inbox: vaultStyle === "para" ? inbox || undefined : undefined,
				projects: vaultStyle === "para" ? projects || undefined : undefined,
				areas: vaultStyle === "para" ? areas || undefined : undefined,
				resources: vaultStyle === "para" ? resources || undefined : undefined,
				archive: vaultStyle === "para" ? archive || undefined : undefined,
				raw: vaultStyle === "wiki" ? raw || undefined : undefined,
				wiki_folder:
					vaultStyle === "wiki" ? wikiFolder || undefined : undefined,
				outputs: vaultStyle === "wiki" ? outputs || undefined : undefined,
				skills: skills || undefined,
				memory: memory || undefined,
			},
			server: {
				port: Number(port) || 3000,
				tls_cert_path: tlsCertPath || undefined,
				tls_key_path: tlsKeyPath || undefined,
				tls_proxy_port: Number(tlsProxyPort) || 3443,
				local_network_access: localNetworkAccess,
				allow_external_agents: allowExternalAgents,
			},
			claude: {
				model,
				effort,
				max_turns: maxTurns !== "" ? Number(maxTurns) : undefined,
				permission_mode: permissionMode,
				turn_recaps: turnRecaps,
			},
			ui: {
				enter_to_submit: enterToSubmit,
				hide_skills_index: hideSkillsIndex,
				theme,
				mobile_theme: mobileTheme === "same" ? undefined : mobileTheme,
			},
			status_vocabulary: {
				active: vocabActive
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				planning: vocabPlanning
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				done: vocabDone
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			},
			attachments: initial.attachments ?? DEFAULT_ATTACHMENTS_CONFIG,
			agents: initial.agents ?? [],
		};

		try {
			const res = await fetch("/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
			if (!res.ok) {
				let msg = "Save failed";
				try {
					const body = (await res.json()) as { error?: string };
					if (body.error) msg = body.error;
				} catch {}
				throw new Error(msg);
			}
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}

	function reloadSession() {
		send({ type: "reload_session" });
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex-1 overflow-auto p-5 space-y-6">
				<UpdatesSection />

				<SystemSection />

				<Section title="Server">
					<Field label="Port">
						<TextInput
							value={port}
							onChange={setPort}
							placeholder="3000"
							mono
						/>
					</Field>
					<Field
						label="Local Network Access"
						hint="binds the server on 0.0.0.0 so devices on your LAN/Tailscale can connect (default binds 127.0.0.1 only). requires restart. anyone on the network can reach the server when on."
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={localNetworkAccess}
								onChange={(e) => setLocalNetworkAccess(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{localNetworkAccess ? "on" : "off"}
							</span>
						</label>
					</Field>
					<Field
						label="Allow External Agents"
						hint="register agent directories outside the vault (e.g. native WSL or Windows project paths). filesystem browse is unrestricted when on; only enable on trusted machines."
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={allowExternalAgents}
								onChange={(e) => setAllowExternalAgents(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{allowExternalAgents ? "on" : "off"}
							</span>
						</label>
					</Field>
				</Section>

				<TailscaleSection
					tlsProxyPort={tlsProxyPort}
					setTlsProxyPort={setTlsProxyPort}
					tlsCertPath={tlsCertPath}
					setTlsCertPath={setTlsCertPath}
					tlsKeyPath={tlsKeyPath}
					setTlsKeyPath={setTlsKeyPath}
					localNetworkAccess={localNetworkAccess}
					cwd={initial.cwd}
				/>

				<Section title="Session">
					<Field
						label="Reload session"
						hint="restarts Claude with the current config and wipes conversation history"
					>
						<button
							type="button"
							onClick={reloadSession}
							className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
						>
							RELOAD
						</button>
					</Field>
					<Field
						label="Privacy mode"
						hint="blur personal data for demos (browser-local, not saved to config)"
					>
						<PrivacyToggle />
					</Field>
				</Section>

				<Section title="UI">
					<div className="px-4 py-3 space-y-2">
						<div className="text-sm text-foreground">Theme</div>
						<div className="grid grid-cols-2 gap-2">
							{(
								[
									{
										value: "dark" as const,
										label: "Dark",
										desc: "neutral dark, sky blue",
									},
									{
										value: "tan" as const,
										label: "Tan",
										desc: "warm parchment, terracotta",
									},
								] satisfies {
									value: "dark" | "tan";
									label: string;
									desc: string;
								}[]
							).map((opt) => (
								<button
									key={opt.value}
									type="button"
									onClick={() => setTheme(opt.value)}
									className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
										theme === opt.value
											? "border-primary bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<span className="text-sm font-medium text-foreground">
										{opt.label}
									</span>
									<span className="text-xs text-muted-foreground">
										{opt.desc}
									</span>
								</button>
							))}
						</div>
					</div>
					<div className="px-4 py-3 space-y-2">
						<div className="text-sm text-foreground">Mobile theme override</div>
						<div className="text-xs text-muted-foreground mb-2">
							override theme on touch devices
						</div>
						<div className="grid grid-cols-3 gap-2">
							{(
								[
									{
										value: "same" as const,
										label: "Same",
										desc: "no override",
									},
									{
										value: "dark" as const,
										label: "Dark",
										desc: "neutral dark, sky blue",
									},
									{
										value: "tan" as const,
										label: "Tan",
										desc: "warm parchment, terracotta",
									},
								] satisfies {
									value: "dark" | "tan" | "same";
									label: string;
									desc: string;
								}[]
							).map((opt) => (
								<button
									key={opt.value}
									type="button"
									onClick={() => setMobileTheme(opt.value)}
									className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
										mobileTheme === opt.value
											? "border-primary bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<span className="text-sm font-medium text-foreground">
										{opt.label}
									</span>
									<span className="text-xs text-muted-foreground">
										{opt.desc}
									</span>
								</button>
							))}
						</div>
					</div>
					<Field
						label="Enter to submit"
						hint="desktop only, mobile always uses Enter for newline"
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={enterToSubmit}
								onChange={(e) => setEnterToSubmit(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{enterToSubmit ? "on" : "off"}
							</span>
						</label>
					</Field>
					<Field label="Hide skills index.md">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={hideSkillsIndex}
								onChange={(e) => setHideSkillsIndex(e.target.checked)}
								className="accent-primary w-3.5 h-3.5"
							/>
							<span className="text-xs text-muted-foreground">
								{hideSkillsIndex ? "on" : "off"}
							</span>
						</label>
					</Field>
				</Section>

				<Section title="Vault">
					<div className="px-4 py-3 space-y-2">
						<div className="text-sm text-foreground">Style</div>
						<div className="grid grid-cols-2 gap-2">
							{[
								{
									value: "para" as const,
									label: "PARA",
									desc: "Inbox · Projects · Areas · Resources · Archive",
								},
								{
									value: "wiki" as const,
									label: "LLM Wiki",
									desc: "Raw · Wiki · Outputs",
								},
							].map((opt) => (
								<button
									key={opt.value}
									type="button"
									onClick={() => setVaultStyle(opt.value)}
									className={`flex flex-col gap-1 p-3 border text-left transition-colors ${
										vaultStyle === opt.value
											? "border-primary bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<span className="text-sm font-medium text-foreground">
										{opt.label}
									</span>
									<span className="text-xs text-muted-foreground">
										{opt.desc}
									</span>
								</button>
							))}
						</div>
					</div>
					<Field label="Name">
						<TextInput value={vaultName} onChange={setVaultName} />
					</Field>
					<Field label="Path">
						<PathField value={vaultPath} onChange={setVaultPath} />
					</Field>
					{vaultStyle === "para" ? (
						<>
							<Field
								label="Inbox folder"
								hint="quick captures, unprocessed notes"
							>
								<RelativeFolderField
									value={inbox}
									onChange={setInbox}
									basePath={vaultPath}
									placeholder="00 Inbox"
								/>
							</Field>
							<Field
								label="Projects folder"
								hint="active work with a defined outcome"
							>
								<RelativeFolderField
									value={projects}
									onChange={setProjects}
									basePath={vaultPath}
									placeholder="10 Projects"
								/>
							</Field>
							<Field
								label="Areas folder"
								hint="ongoing responsibilities with no end date"
							>
								<RelativeFolderField
									value={areas}
									onChange={setAreas}
									basePath={vaultPath}
									placeholder="20 Areas"
								/>
							</Field>
							<Field
								label="Resources folder"
								hint="reference material organized by topic"
							>
								<RelativeFolderField
									value={resources}
									onChange={setResources}
									basePath={vaultPath}
									placeholder="30 Resources"
								/>
							</Field>
							<Field
								label="Archive folder"
								hint="completed or inactive projects and areas"
							>
								<RelativeFolderField
									value={archive}
									onChange={setArchive}
									basePath={vaultPath}
									placeholder="40 Archive"
								/>
							</Field>
						</>
					) : (
						<>
							<Field
								label="Raw folder"
								hint="unprocessed notes / quick captures"
							>
								<RelativeFolderField
									value={raw}
									onChange={setRaw}
									basePath={vaultPath}
									placeholder="raw"
								/>
							</Field>
							<Field
								label="Wiki folder"
								hint="curated knowledge pages, LLM-maintained"
							>
								<RelativeFolderField
									value={wikiFolder}
									onChange={setWikiFolder}
									basePath={vaultPath}
									placeholder="wiki"
								/>
							</Field>
							<Field
								label="Outputs folder"
								hint="generated content, blog posts, essays"
							>
								<RelativeFolderField
									value={outputs}
									onChange={setOutputs}
									basePath={vaultPath}
									placeholder="outputs"
								/>
							</Field>
						</>
					)}
					<Field
						label="Skills folder"
						hint="vault skills (relative to vault path)"
					>
						<RelativeFolderField
							value={skills}
							onChange={setSkills}
							basePath={vaultPath}
							placeholder=".claude/skills"
						/>
					</Field>
					<Field
						label="Memory folder"
						hint="vault memory files (relative to vault path)"
					>
						<RelativeFolderField
							value={memory}
							onChange={setMemory}
							basePath={vaultPath}
							placeholder=".claude/projects"
						/>
					</Field>
				</Section>

				<Section title="Status Vocabulary">
					<VocabRow
						label="Active"
						value={vocabActive}
						onChange={setVocabActive}
					/>
					<VocabRow
						label="Planning"
						value={vocabPlanning}
						onChange={setVocabPlanning}
					/>
					<VocabRow label="Done" value={vocabDone} onChange={setVocabDone} />
				</Section>

				<McpSection vaultPath={vaultPath} />

				<Section title="Claude">
					<Field label="Model">
						<select
							value={model}
							onChange={(e) => setModel(e.target.value)}
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
						>
							{MODEL_OPTIONS.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					<div className="px-4 py-3 space-y-2">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							EFFORT
						</div>
						<div className="space-y-1.5">
							{EFFORT_OPTIONS.map((opt) => (
								<label
									key={opt.value}
									className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
										effort === opt.value
											? "border-primary/40 bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<input
										type="radio"
										name="effort"
										value={opt.value}
										checked={effort === opt.value}
										onChange={() => setEffort(opt.value)}
										className="mt-0.5 accent-primary shrink-0"
									/>
									<div>
										<div className="text-sm text-foreground">{opt.label}</div>
										<div className="text-xs text-muted-foreground">
											{opt.desc}
										</div>
									</div>
								</label>
							))}
						</div>
					</div>
					<div className="px-4 py-3 space-y-2">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							PERMISSIONS
						</div>
						<div className="space-y-1.5">
							{PERMISSION_OPTIONS.map((opt) => (
								<label
									key={opt.value}
									className={`flex items-start gap-3 p-3 border cursor-pointer transition-colors ${
										permissionMode === opt.value
											? "border-primary/40 bg-primary/5"
											: "border-border hover:bg-accent"
									}`}
								>
									<input
										type="radio"
										name="permission"
										value={opt.value}
										checked={permissionMode === opt.value}
										onChange={() => setPermissionMode(opt.value)}
										className="mt-0.5 accent-primary shrink-0"
									/>
									<div>
										<div className="text-sm text-foreground">{opt.label}</div>
										<div className="text-xs text-muted-foreground">
											{opt.desc}
										</div>
									</div>
								</label>
							))}
						</div>
					</div>
					<Field
						label="Max turns"
						hint="max turns Claude can run, blank means no limit"
					>
						<input
							type="number"
							min={1}
							value={maxTurns}
							onChange={(e) => setMaxTurns(e.target.value)}
							placeholder="unlimited"
							className="w-32 sm:w-48 bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
						/>
					</Field>
					<Field
						label="Turn recaps"
						hint="generate a brief Haiku summary after turns with tool use"
					>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={turnRecaps}
								onChange={(e) => setTurnRecaps(e.target.checked)}
								className="w-3.5 h-3.5 accent-primary"
							/>
							<span className="text-xs text-muted-foreground">enabled</span>
						</label>
					</Field>
				</Section>

				<EventLogSection />
			</div>

			{/* Save bar */}
			<div className="shrink-0 border-t border-border bg-background/95 px-5 py-3 flex items-center justify-between gap-4">
				<div className="text-xs tracking-wider">
					{error && <span className="text-destructive">{error}</span>}
					{saved && (
						<span className="text-green-500">
							saved, reload session to apply changes
						</span>
					)}
				</div>
				<button
					type="button"
					onClick={save}
					disabled={saving}
					className="px-4 py-2 bg-primary text-primary-foreground text-[10px] tracking-widest font-bold hover:opacity-90 transition-opacity disabled:opacity-50 uppercase"
				>
					{saving ? "SAVING…" : "SAVE CHANGES"}
				</button>
			</div>
		</div>
	);
}
