import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

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
export type VaultMcpConfig = StdioConfig | RemoteConfig;
export type VaultMcpServer = {
	name: string;
	config: VaultMcpConfig;
	disabled: boolean;
};

// ─── Form types ───────────────────────────────────────────────────────────────

export type ServerFormFields = {
	type: "stdio" | "http" | "sse";
	command: string;
	args: string;
	url: string;
	env: string;
	headers: string;
};

const DEFAULT_FORM: ServerFormFields = {
	type: "stdio",
	command: "",
	args: "",
	url: "",
	env: "",
	headers: "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDelimited(
	text: string,
	sep: "=" | ":",
): Record<string, string> | undefined {
	const entries = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.includes(sep))
		.map((l) => {
			const idx = l.indexOf(sep);
			return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [
				string,
				string,
			];
		})
		.filter(([k]) => k.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializeDelimited(
	obj: Record<string, string> | undefined,
	sep: "=" | ": ",
): string {
	if (!obj) return "";
	return Object.entries(obj)
		.map(([k, v]) => `${k}${sep}${v}`)
		.join("\n");
}

const parseKV = (text: string) => parseDelimited(text, "=");
const parseHeader = (text: string) => parseDelimited(text, ":");
const serializeKV = (obj: Record<string, string> | undefined) =>
	serializeDelimited(obj, "=");
const serializeHeader = (obj: Record<string, string> | undefined) =>
	serializeDelimited(obj, ": ");

function KvTextarea({
	value,
	onChange,
	placeholder,
	"aria-label": ariaLabel,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder: string;
	"aria-label"?: string;
}) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			aria-label={ariaLabel}
			rows={3}
			className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors resize-none"
		/>
	);
}

/** Build a VaultMcpConfig from form fields. Returns config or error string. */
function buildMcpConfig(fields: ServerFormFields): VaultMcpConfig | string {
	if (fields.type === "stdio") {
		if (!fields.command.trim()) return "Command required";
		const args = fields.args
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);
		const env = parseKV(fields.env);
		return {
			command: fields.command.trim(),
			...(args.length ? { args } : {}),
			...(env ? { env } : {}),
		};
	}
	if (!fields.url.trim()) return "URL required";
	try {
		new URL(fields.url.trim());
	} catch {
		return "Invalid URL";
	}
	const headers = parseHeader(fields.headers);
	return {
		type: fields.type,
		url: fields.url.trim(),
		...(headers ? { headers } : {}),
	};
}

/** Derive initial form state from an existing server. */
export function computeInitialForm(s: VaultMcpServer): ServerFormFields {
	if ("url" in s.config) {
		return {
			type: s.config.type === "sse" ? "sse" : "http",
			url: s.config.url,
			headers: serializeHeader(s.config.headers),
			command: "",
			args: "",
			env: "",
		};
	}
	return {
		type: "stdio",
		command: s.config.command,
		args: (s.config.args ?? []).join(", "),
		env: serializeKV(s.config.env),
		url: "",
		headers: "",
	};
}

// ─── Shared form body ─────────────────────────────────────────────────────────

function McpServerFormBody({
	form,
	setForm,
}: {
	form: ServerFormFields;
	setForm: Dispatch<SetStateAction<ServerFormFields>>;
}) {
	if (form.type === "stdio") {
		return (
			<>
				<div className="flex gap-3">
					<div className="flex-1 space-y-1">
						<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
							Command
						</div>
						<input
							type="text"
							aria-label="Command"
							value={form.command}
							onChange={(e) =>
								setForm((f) => ({ ...f, command: e.target.value }))
							}
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
							aria-label="Args (comma-separated)"
							value={form.args}
							onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
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
						value={form.env}
						onChange={(v) => setForm((f) => ({ ...f, env: v }))}
						placeholder={"API_KEY=abc123\nANOTHER_VAR=value"}
						aria-label="Env vars (KEY=value, one per line)"
					/>
				</div>
			</>
		);
	}
	return (
		<>
			<div className="space-y-1">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					URL
				</div>
				<input
					type="text"
					aria-label="URL"
					value={form.url}
					onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
					placeholder="https://example.com/mcp"
					className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
				/>
			</div>
			<div className="space-y-1">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					Headers (KEY: value, one per line)
				</div>
				<KvTextarea
					value={form.headers}
					onChange={(v) => setForm((f) => ({ ...f, headers: v }))}
					placeholder={"Authorization: Bearer token123\nX-Api-Key: key"}
					aria-label="Headers (KEY: value, one per line)"
				/>
			</div>
		</>
	);
}

function McpServerTypeSelect({
	form,
	setForm,
}: {
	form: ServerFormFields;
	setForm: Dispatch<SetStateAction<ServerFormFields>>;
}) {
	return (
		<select
			value={form.type}
			onChange={(event) =>
				setForm((current) => ({
					...current,
					type: event.target.value as ServerFormFields["type"],
				}))
			}
			className="bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-primary/50 transition-colors appearance-none cursor-pointer"
		>
			<option value="stdio">stdio</option>
			<option value="http">http</option>
			<option value="sse">sse</option>
		</select>
	);
}

function McpServerFormActions({
	error,
	onCancel,
	onSubmit,
	isSubmitting,
	children,
}: {
	error: string | null;
	onCancel: () => void;
	onSubmit: () => void;
	isSubmitting: boolean;
	children: ReactNode;
}) {
	return (
		<>
			{error && <div className="text-xs text-destructive">{error}</div>}
			<div className="flex gap-2 justify-end pt-1">
				<button
					type="button"
					onClick={onCancel}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent transition-colors uppercase"
				>
					CANCEL
				</button>
				<button
					type="button"
					onClick={onSubmit}
					disabled={isSubmitting}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors uppercase disabled:opacity-50"
				>
					{children}
				</button>
			</div>
		</>
	);
}

// ─── EditMcpServerForm ────────────────────────────────────────────────────────

export function EditMcpServerForm({
	serverName,
	initialForm,
	opError,
	onSave,
	onCancel,
}: {
	serverName: string;
	initialForm: ServerFormFields;
	opError: string | null;
	onSave: (config: VaultMcpConfig) => Promise<void>;
	onCancel: () => void;
}) {
	const [form, setForm] = useState<ServerFormFields>(initialForm);
	const [formError, setFormError] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const isMountedRef = useRef(true);
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	async function handleSave() {
		if (isSaving) return;
		setFormError(null);
		const cfgOrErr = buildMcpConfig(form);
		if (typeof cfgOrErr === "string") {
			setFormError(cfgOrErr);
			return;
		}
		setIsSaving(true);
		try {
			await onSave(cfgOrErr);
		} catch (err) {
			if (isMountedRef.current)
				setFormError(err instanceof Error ? err.message : "Save failed");
		} finally {
			if (isMountedRef.current) setIsSaving(false);
		}
	}

	return (
		<div className="px-4 py-4 space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
					Edit: {serverName}
				</div>
				<McpServerTypeSelect form={form} setForm={setForm} />
			</div>
			<McpServerFormBody form={form} setForm={setForm} />
			<McpServerFormActions
				error={formError ?? opError}
				onCancel={onCancel}
				onSubmit={() => void handleSave()}
				isSubmitting={isSaving}
			>
				{isSaving ? "SAVING…" : "SAVE"}
			</McpServerFormActions>
		</div>
	);
}

// ─── AddMcpServerForm ─────────────────────────────────────────────────────────

export function AddMcpServerForm({
	opError,
	onAdd,
	onCancel,
}: {
	opError: string | null;
	onAdd: (name: string, config: VaultMcpConfig) => Promise<void>;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	const [form, setForm] = useState<ServerFormFields>(DEFAULT_FORM);
	const [formError, setFormError] = useState<string | null>(null);
	const [isAdding, setIsAdding] = useState(false);
	const isMountedRef = useRef(true);
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	async function handleAdd() {
		if (isAdding) return;
		setFormError(null);
		if (!name.trim()) {
			setFormError("Name required");
			return;
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
			setFormError(
				"Name may only contain letters, numbers, hyphens, and underscores",
			);
			return;
		}
		const cfgOrErr = buildMcpConfig(form);
		if (typeof cfgOrErr === "string") {
			setFormError(cfgOrErr);
			return;
		}
		setIsAdding(true);
		try {
			await onAdd(name.trim(), cfgOrErr);
		} catch (err) {
			if (isMountedRef.current)
				setFormError(err instanceof Error ? err.message : "Add failed");
		} finally {
			if (isMountedRef.current) setIsAdding(false);
		}
	}

	return (
		<div className="px-4 py-4 space-y-3">
			<div className="flex gap-3">
				<div className="flex-1 space-y-1">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Name
					</div>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="my-server"
						className="w-full bg-secondary border border-border px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition-colors"
					/>
				</div>
				<div className="space-y-1">
					<div className="text-[9px] tracking-widest text-muted-foreground uppercase">
						Type
					</div>
					<McpServerTypeSelect form={form} setForm={setForm} />
				</div>
			</div>
			<McpServerFormBody form={form} setForm={setForm} />
			<McpServerFormActions
				error={formError ?? opError}
				onCancel={onCancel}
				onSubmit={() => void handleAdd()}
				isSubmitting={isAdding}
			>
				{isAdding ? "ADDING…" : "ADD"}
			</McpServerFormActions>
		</div>
	);
}
