import { ChevronRight, FileDiff } from "lucide-react";
import { useState } from "react";
import { ObsidianOpenButton } from "#/components/ObsidianOpenButton";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";

type VaultChangeKind =
	| "created"
	| "appended"
	| "prepended"
	| "replaced"
	| "patched"
	| "moved"
	| "renamed"
	| "trashed"
	| "base"
	| "task"
	| "property-set"
	| "property-remove"
	| "command";

export type ObsidianVaultChange = {
	id: string;
	kind: VaultChangeKind;
	path?: string;
	from?: string;
	content?: string;
	previousContent?: string;
	commandId?: string;
	activeBefore?: string;
	activeAfter?: string;
	summary?: string;
};

const OPERATION_NAMES: Record<string, VaultChangeKind> = {
	create_note: "created",
	capture_note: "created",
	append_note: "appended",
	prepend_note: "prepended",
	replace_note_text: "replaced",
	patch_note: "patched",
	move_file: "moved",
	rename_file: "renamed",
	trash_file: "trashed",
	base_create: "base",
	task_update: "task",
	property_set: "property-set",
	property_remove: "property-remove",
	run_command: "command",
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function operationFromToolName(name: string): string | null {
	const normalized = name.toLowerCase();
	for (const operation of Object.keys(OPERATION_NAMES)) {
		if (
			normalized === operation ||
			normalized.endsWith(`__${operation}`) ||
			normalized.endsWith(`.${operation}`) ||
			normalized.endsWith(`/${operation}`) ||
			normalized.endsWith(`:${operation}`)
		) {
			return operation;
		}
	}
	return null;
}

function resultRecord(
	result: string | undefined,
): Record<string, unknown> | null {
	if (!result) return null;
	try {
		const parsed: unknown = JSON.parse(result);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const direct = parsed as Record<string, unknown>;
		for (const key of ["contentItems", "content"]) {
			const items = direct[key];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				const nested = record(item);
				if (typeof nested.text !== "string") continue;
				const unwrapped = resultRecord(nested.text);
				if (unwrapped) return unwrapped;
			}
		}
		return direct;
	} catch {
		return null;
	}
}

function resultIndicatesFailure(result: string): boolean {
	try {
		const parsed = record(JSON.parse(result));
		if (parsed.success === false) return true;
		const status =
			typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
		return [
			"failed",
			"error",
			"errored",
			"cancelled",
			"canceled",
			"declined",
		].includes(status);
	} catch {
		return false;
	}
}

function resultPath(result: string | undefined): string | null {
	const path = resultRecord(result)?.path;
	return typeof path === "string" && path ? path : null;
}

function renamedPath(source: string, name: string): string {
	const slash = source.lastIndexOf("/");
	return slash < 0 ? name : `${source.slice(0, slash)}/${name}`;
}

function inlineValue(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "unknown";
	return serialized.length > 240 ? `${serialized.slice(0, 240)}…` : serialized;
}

function patchContent(
	replacements: unknown[],
	key: "oldText" | "newText",
): string {
	return replacements
		.map((item, index) => {
			const value = record(item)[key];
			return typeof value === "string"
				? `[${index + 1}]\n${value}`
				: `[${index + 1}]`;
		})
		.join("\n\n");
}

export function obsidianVaultChanges(
	toolEvents: ToolEventMessage[],
): ObsidianVaultChange[] {
	return toolEvents.flatMap<ObsidianVaultChange>((event) => {
		const operation = operationFromToolName(event.name);
		if (
			!operation ||
			event.isError ||
			typeof event.result !== "string" ||
			resultIndicatesFailure(event.result)
		)
			return [];
		const input = record(event.input);
		if (operation === "run_command") {
			const commandId = typeof input.id === "string" ? input.id : null;
			const result = resultRecord(event.result);
			const activeBefore =
				typeof result?.activeBefore === "string" && result.activeBefore
					? result.activeBefore
					: null;
			const activeAfter =
				typeof result?.activeAfter === "string" && result.activeAfter
					? result.activeAfter
					: null;
			return commandId
				? [
						{
							id: event.id,
							kind: "command" as const,
							commandId,
							...(activeBefore ? { activeBefore } : {}),
							...(activeAfter ? { activeAfter } : {}),
						},
					]
				: [];
		}
		if (operation === "base_create") {
			const basePath = typeof input.path === "string" ? input.path : null;
			const name = typeof input.name === "string" ? input.name : null;
			if (!basePath || !name) return [];
			return [
				{
					id: event.id,
					kind: "base" as const,
					summary: `${name} via ${basePath}`,
					...(typeof input.content === "string" && input.content
						? { content: input.content }
						: {}),
				},
			];
		}
		if (operation === "task_update") {
			const path = typeof input.path === "string" ? input.path : null;
			const line = typeof input.line === "number" ? input.line : null;
			const action = typeof input.action === "string" ? input.action : null;
			if (!path || line === null || !action) return [];
			const status = typeof input.status === "string" ? input.status : null;
			return [
				{
					id: event.id,
					kind: "task" as const,
					path,
					summary: `${path}:${line} · ${action === "status" && status ? `status ${status}` : action}`,
				},
			];
		}
		if (operation === "property_set" || operation === "property_remove") {
			const path = typeof input.path === "string" ? input.path : null;
			const name = typeof input.name === "string" ? input.name : null;
			if (!path || !name) return [];
			const value =
				operation === "property_set" ? inlineValue(input.value) : null;
			return [
				{
					id: event.id,
					kind:
						operation === "property_set"
							? ("property-set" as const)
							: ("property-remove" as const),
					path,
					summary:
						operation === "property_set"
							? `${path} · ${name} = ${value}`
							: `${path} · removed ${name}`,
				},
			];
		}
		if (operation === "patch_note") {
			const source = typeof input.path === "string" ? input.path : null;
			const replacements = Array.isArray(input.replacements)
				? input.replacements
				: [];
			const path = resultPath(event.result) ?? source;
			if (!path || replacements.length === 0) return [];
			return [
				{
					id: event.id,
					kind: "patched" as const,
					path,
					summary: `${path} · ${replacements.length} replacements`,
					previousContent: patchContent(replacements, "oldText"),
					content: patchContent(replacements, "newText"),
				},
			];
		}
		if (operation === "trash_file") {
			const path =
				resultPath(event.result) ??
				(typeof input.path === "string" ? input.path : null);
			return path
				? [
						{
							id: event.id,
							kind: "trashed" as const,
							path,
							summary: path,
						},
					]
				: [];
		}
		const source = typeof input.path === "string" ? input.path : null;
		const reportedPath = resultPath(event.result);
		let path = reportedPath;
		if (!path && operation === "create_note") path = source;
		if (
			!path &&
			(operation === "append_note" || operation === "prepend_note") &&
			input.target === "path"
		) {
			path = source;
		}
		if (!path && operation === "move_file" && typeof input.to === "string") {
			path = input.to;
		}
		if (
			!path &&
			operation === "rename_file" &&
			source &&
			typeof input.name === "string"
		) {
			path = renamedPath(source, input.name);
		}
		if (!path) return [];
		return [
			{
				id: event.id,
				kind: OPERATION_NAMES[operation] as VaultChangeKind,
				path,
				...(source &&
				source !== path &&
				(operation === "move_file" || operation === "rename_file")
					? { from: source }
					: {}),
				...(typeof input.content === "string" && input.content
					? { content: input.content }
					: {}),
				...(operation === "replace_note_text" &&
				typeof input.oldText === "string" &&
				input.oldText
					? { previousContent: input.oldText }
					: {}),
				...(operation === "replace_note_text" &&
				typeof input.newText === "string"
					? { content: input.newText }
					: {}),
			},
		];
	});
}

function changeLabel(kind: VaultChangeKind): string {
	switch (kind) {
		case "created":
			return "Created";
		case "appended":
			return "Appended";
		case "prepended":
			return "Prepended";
		case "replaced":
			return "Replaced";
		case "patched":
			return "Patched";
		case "moved":
			return "Moved";
		case "renamed":
			return "Renamed";
		case "trashed":
			return "Trashed";
		case "base":
			return "Base item";
		case "task":
			return "Task";
		case "property-set":
			return "Property";
		case "property-remove":
			return "Property";
		case "command":
			return "Command";
	}
}

function changedContentPreview(content: string, prefix: "+" | "-"): string {
	const bounded =
		content.length > 1_200 ? `${content.slice(0, 1_200)}\n…` : content;
	return bounded
		.split("\n")
		.map((line) => `${prefix} ${line}`)
		.join("\n");
}

export function ObsidianVaultChangeReview({
	toolEvents,
}: {
	toolEvents: ToolEventMessage[];
}) {
	const [open, setOpen] = useState(false);
	const changes = obsidianVaultChanges(toolEvents);
	if (changes.length === 0) return null;
	const hasFileChanges = changes.some((change) => Boolean(change.path));

	return (
		<div className="mx-3 my-1.5 min-w-0 border border-primary/15 bg-primary/[0.02]">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={`Vault activity, ${changes.length}`}
				className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-primary/[0.04]"
			>
				<ChevronRight
					className={`h-3 w-3 shrink-0 text-primary/50 transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<FileDiff className="h-3 w-3 shrink-0 text-primary/60" />
				<span className="text-[10px] font-medium tracking-wider text-primary/70 uppercase">
					Vault activity
				</span>
				<span className="text-[10px] text-muted-foreground/55 tabular-nums">
					{changes.length}
				</span>
			</button>
			{open && (
				<div className="border-t border-primary/10 px-3 py-2 space-y-2">
					{changes.map((change) => (
						<div key={change.id} className="min-w-0 text-[11px]">
							<div className="flex min-w-0 items-start gap-2">
								<span className="w-14 shrink-0 text-[9px] font-medium tracking-wider text-muted-foreground/60 uppercase">
									{changeLabel(change.kind)}
								</span>
								<div className="min-w-0 flex-1">
									<PrivacyMask className="font-mono text-primary/75">
										{change.commandId ??
											change.summary ??
											(change.from
												? `${change.from} → ${change.path}`
												: change.path)}
									</PrivacyMask>
									{change.kind === "command" && (
										<div className="mt-1 space-y-0.5 text-[9px] text-muted-foreground/55">
											{change.activeBefore &&
											change.activeBefore === change.activeAfter ? (
												<div className="flex min-w-0 items-center gap-1.5">
													<span className="shrink-0">Active note when run</span>
													<PrivacyMask className="min-w-0 truncate font-mono text-primary/65">
														{change.activeBefore}
													</PrivacyMask>
													<ObsidianOpenButton
														relativePath={change.activeBefore}
													/>
												</div>
											) : (
												<>
													{change.activeBefore && (
														<div className="flex min-w-0 items-center gap-1.5">
															<span className="shrink-0">Active before</span>
															<PrivacyMask className="min-w-0 truncate font-mono text-primary/65">
																{change.activeBefore}
															</PrivacyMask>
															<ObsidianOpenButton
																relativePath={change.activeBefore}
															/>
														</div>
													)}
													{change.activeAfter && (
														<div className="flex min-w-0 items-center gap-1.5">
															<span className="shrink-0">Active after</span>
															<PrivacyMask className="min-w-0 truncate font-mono text-primary/65">
																{change.activeAfter}
															</PrivacyMask>
															<ObsidianOpenButton
																relativePath={change.activeAfter}
															/>
														</div>
													)}
												</>
											)}
											{!change.activeBefore && !change.activeAfter && (
												<p>Active-note context unavailable</p>
											)}
											<p className="text-muted-foreground/45">
												Commands may affect other vault files.
											</p>
										</div>
									)}
								</div>
								{change.path && change.kind !== "trashed" && (
									<ObsidianOpenButton relativePath={change.path} />
								)}
							</div>
							{change.previousContent && (
								<PrivacyMask className="mt-1 ml-16 max-h-28 overflow-auto whitespace-pre-wrap border-l border-red-600/25 pl-2 font-mono text-[10px] leading-relaxed text-red-700/70 dark:text-red-400/60">
									{changedContentPreview(change.previousContent, "-")}
								</PrivacyMask>
							)}
							{change.content && (
								<PrivacyMask className="mt-1 ml-16 max-h-28 overflow-auto whitespace-pre-wrap border-l border-green-600/25 pl-2 font-mono text-[10px] leading-relaxed text-green-700/70 dark:text-green-400/60">
									{changedContentPreview(change.content, "+")}
								</PrivacyMask>
							)}
						</div>
					))}
					{hasFileChanges && (
						<p className="pl-16 text-[9px] text-muted-foreground/45">
							Use Obsidian for full history and recovery options.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
