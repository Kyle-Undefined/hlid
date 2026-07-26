import { Bot, ShieldCheck } from "lucide-react";
import {
	permissionInputPreview,
	permissionPolicySummary,
} from "#/lib/permissionPresentation";
import type { SubagentSnapshot } from "#/server/agentProvider";
import type { PermissionMessage } from "./chatReducer";

function RequestHeader({
	message,
	actionName,
	requesterSubagent,
}: {
	message: PermissionMessage;
	actionName: string;
	requesterSubagent?: SubagentSnapshot;
}) {
	const requesterName =
		requesterSubagent?.name ??
		requesterSubagent?.label ??
		message.requester?.agentType ??
		(message.requester ? "Subagent" : undefined);
	const requesterStep =
		requesterSubagent?.currentStep ?? requesterSubagent?.description;
	return (
		<>
			<div className="mb-1 text-[9px] tracking-widest text-muted-foreground/65 uppercase">
				Permission request
			</div>
			<div className="text-sm text-foreground">{actionName}</div>
			{message.title && message.title !== actionName && (
				<div className="mt-0.5 text-xs text-muted-foreground/75">
					{message.title}
				</div>
			)}
			{message.requester && (
				<div className="mt-2 flex min-w-0 items-start gap-2 border border-primary/15 bg-primary/[0.03] px-2 py-2">
					<Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/60" />
					<div className="min-w-0">
						<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
							Requested by
						</div>
						<div className="mt-0.5 break-words text-xs text-foreground/90">
							{requesterName}
						</div>
						{requesterStep && (
							<div className="mt-0.5 break-words text-[10px] text-muted-foreground/65">
								{requesterStep}
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}

function ApplicationContext({
	appName,
	appId,
}: {
	appName?: string;
	appId?: string;
}) {
	const identity = appName ?? appId;
	if (!identity) return null;
	return (
		<div className="mt-2 min-w-0 max-w-full overflow-hidden border border-border bg-secondary/60 px-2 py-2">
			<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
				Application
			</div>
			<div className="mt-0.5 break-all text-xs text-foreground/90">
				{identity}
			</div>
			{appId && appId !== appName && (
				<div className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground/65">
					{appId}
				</div>
			)}
			<div className="mt-1.5 text-[9px] text-muted-foreground/55">
				Always applies only to this application.
			</div>
		</div>
	);
}

function ActionContext({
	message,
	appIdentity,
}: {
	message: PermissionMessage;
	appIdentity?: string;
}) {
	const activeNote =
		typeof message.input?.activeNote === "string"
			? message.input.activeNote
			: undefined;
	const preview = appIdentity
		? undefined
		: permissionInputPreview(message.input, message.toolName);
	return (
		<>
			{activeNote && (
				<div className="mt-2 min-w-0 max-w-full overflow-hidden border border-border bg-secondary/60 px-2 py-2">
					<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
						Active note
					</div>
					<div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/85">
						{activeNote}
					</div>
				</div>
			)}
			{preview && (
				<div className="mt-2 min-w-0 max-w-full overflow-hidden whitespace-pre-wrap break-all border border-border bg-secondary/60 px-2 py-1.5 font-mono text-[11px] text-foreground/80">
					{preview}
				</div>
			)}
			{message.description && (
				<div className="mt-1 text-xs text-muted-foreground/75">
					{message.description}
				</div>
			)}
		</>
	);
}

function PolicyContext({ message }: { message: PermissionMessage }) {
	if (!message.policy) return null;
	return (
		<div className="mt-2 flex min-w-0 items-start gap-2 border border-border bg-secondary/35 px-2 py-2">
			<ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
			<div className="min-w-0">
				<div className="text-[8px] tracking-widest text-muted-foreground/55 uppercase">
					Policy
				</div>
				<div className="mt-0.5 text-xs text-muted-foreground/75">
					{permissionPolicySummary(message.policy.reason)}
				</div>
			</div>
		</div>
	);
}

function TechnicalField({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-w-0">
			<div className="text-[8px] tracking-widest uppercase">{label}</div>
			<div className="break-all text-foreground/70">{children}</div>
		</div>
	);
}

function TechnicalDetails({ message }: { message: PermissionMessage }) {
	const technicalInput = message.input
		? JSON.stringify(message.input, null, 2)
		: undefined;
	return (
		<details className="mt-2 border-t border-border/70 pt-2 text-[10px] text-muted-foreground/65">
			<summary className="cursor-pointer select-none tracking-wider uppercase hover:text-foreground/70">
				Technical details
			</summary>
			<div className="mt-2 grid min-w-0 gap-2 font-mono">
				<TechnicalField label="Tool">{message.toolName}</TechnicalField>
				<TechnicalField label="Request">{message.id}</TechnicalField>
				{message.requester && (
					<TechnicalField label="Caller">
						{message.requester.providerId} / {message.requester.agentId}
						{message.requester.agentType && (
							<div className="text-muted-foreground/60">
								type {message.requester.agentType}
							</div>
						)}
					</TechnicalField>
				)}
				{message.policy && (
					<TechnicalField label="Umbod reason">
						<span className="whitespace-pre-wrap break-words">
							{message.policy.reason}
						</span>
					</TechnicalField>
				)}
				{technicalInput && (
					<TechnicalField label="Input">
						<pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all">
							{technicalInput}
						</pre>
					</TechnicalField>
				)}
			</div>
		</details>
	);
}

export function PermissionCardContent({
	message,
	actionName,
	requesterSubagent,
}: {
	message: PermissionMessage;
	actionName: string;
	requesterSubagent?: SubagentSnapshot;
}) {
	const appName =
		typeof message.input?.appName === "string"
			? message.input.appName
			: undefined;
	const appId =
		typeof message.input?.appId === "string" ? message.input.appId : undefined;
	return (
		<div className="min-w-0 max-w-full overflow-hidden border-b border-border px-4 py-3">
			<RequestHeader
				message={message}
				actionName={actionName}
				requesterSubagent={requesterSubagent}
			/>
			<ApplicationContext appName={appName} appId={appId} />
			<ActionContext message={message} appIdentity={appName ?? appId} />
			<PolicyContext message={message} />
			<TechnicalDetails message={message} />
		</div>
	);
}
