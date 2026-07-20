import { ChevronRight, FileDiff } from "lucide-react";
import { useState } from "react";
import { ObsidianOpenButton } from "#/components/ObsidianOpenButton";
import { PrivacyMask } from "#/components/PrivacyMask";
import type { ToolEventMessage } from "#/server/protocol";

type VaultChangeKind =
	| "created"
	| "appended"
	| "prepended"
	| "moved"
	| "renamed"
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
	commandId?: string;
	summary?: string;
};

const OPERATION_NAMES: Record<string, VaultChangeKind> = {
	create_note: "created",
	capture_note: "created",
	append_note: "appended",
	prepend_note: "prepended",
	move_file: "moved",
	rename_file: "renamed",
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

function resultPath(result: string | undefined): string | null {
	if (!result) return null;
	try {
		const parsed: unknown = JSON.parse(result);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const path = (parsed as { path?: unknown }).path;
		return typeof path === "string" && path ? path : null;
	} catch {
		return null;
	}
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

export function obsidianVaultChanges(
	toolEvents: ToolEventMessage[],
): ObsidianVaultChange[] {
	return toolEvents.flatMap<ObsidianVaultChange>((event) => {
		const operation = operationFromToolName(event.name);
		if (!operation || event.isError || typeof event.result !== "string")
			return [];
		const input = record(event.input);
		if (operation === "run_command") {
			const commandId = typeof input.id === "string" ? input.id : null;
			return commandId
				? [
						{
							id: event.id,
							kind: "command" as const,
							commandId,
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
		const source = typeof input.path === "string" ? input.path : null;
		const reportedPath = resultPath(event.result);
		let path = reportedPath;
		if (!path && operation === "create_note") path = source;
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
		case "moved":
			return "Moved";
		case "renamed":
			return "Renamed";
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

function addedContentPreview(content: string): string {
	const bounded =
		content.length > 1_200 ? `${content.slice(0, 1_200)}\n…` : content;
	return bounded
		.split("\n")
		.map((line) => `+ ${line}`)
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
										<p className="mt-0.5 text-[9px] text-muted-foreground/50">
											Affected files unknown
										</p>
									)}
								</div>
								{change.path && (
									<ObsidianOpenButton relativePath={change.path} />
								)}
							</div>
							{change.content && (
								<PrivacyMask className="mt-1 ml-16 max-h-28 overflow-auto whitespace-pre-wrap border-l border-green-600/25 pl-2 font-mono text-[10px] leading-relaxed text-green-700/70 dark:text-green-400/60">
									{addedContentPreview(change.content)}
								</PrivacyMask>
							)}
						</div>
					))}
					{hasFileChanges && (
						<p className="pl-16 text-[9px] text-muted-foreground/45">
							Open a note in Obsidian for its full history and recovery options.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
