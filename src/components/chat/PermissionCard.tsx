import { Check, X } from "lucide-react";
import { permissionToolDisplayName } from "#/lib/permissionPresentation";
import type { SubagentSnapshot } from "#/server/agentProvider";
import { approvedLabel } from "#/server/protocol";
import type { PermissionMessage } from "./chatReducer";
import { PermissionCardContent } from "./PermissionCardContent";
import {
	PermissionCardControls,
	type PermissionDecisionHandler,
} from "./PermissionCardControls";

export type { PermissionDecisionHandler };

function CompletedPermissionCard({
	message,
	actionName,
}: {
	message: PermissionMessage;
	actionName: string;
}) {
	const humanDecision =
		message.decision === "provider_blocked" ? null : message.decision;
	const approvedText =
		humanDecision === null || humanDecision === "pending"
			? null
			: approvedLabel(humanDecision);
	const approved = approvedText !== null;
	const providerBlocked = message.providerOutcome === "blocked";
	return (
		<div className="flex gap-0">
			<div className="w-12 shrink-0 pt-0.5 text-[9px] tracking-widest text-muted-foreground/50 uppercase">
				Perm
			</div>
			<div
				className="flex flex-col gap-1 text-xs text-muted-foreground/65"
				title={message.providerMessage ?? message.providerReason}
			>
				{humanDecision !== null && humanDecision !== "pending" && (
					<div className="flex items-center gap-2">
						{approved ? (
							<Check className="h-3 w-3 text-status-success/60" />
						) : (
							<X className="h-3 w-3 text-destructive/60" />
						)}
						<span className="text-[10px] tracking-wider">
							{actionName.toUpperCase()} {approvedText ?? "DENIED"}
						</span>
					</div>
				)}
				{providerBlocked && (
					<div className="flex items-center gap-2">
						<X className="h-3 w-3 text-destructive/60" />
						<span className="text-[10px] tracking-wider">
							{actionName.toUpperCase()} BLOCKED/PROVIDER-REPORTED
						</span>
					</div>
				)}
			</div>
		</div>
	);
}

export function PermissionCard({
	message,
	onDecide,
	requesterSubagent,
	embedded = false,
}: {
	message: PermissionMessage;
	onDecide: PermissionDecisionHandler;
	requesterSubagent?: SubagentSnapshot;
	embedded?: boolean;
}) {
	const actionName =
		message.displayName ?? permissionToolDisplayName(message.toolName);
	if (message.decision !== "pending" || message.providerOutcome === "blocked") {
		return (
			<CompletedPermissionCard message={message} actionName={actionName} />
		);
	}
	return (
		<div
			className={`flex min-w-0 max-w-full gap-0 overflow-hidden ${
				embedded ? "mx-3 mb-2 w-[calc(100%_-_1.5rem)]" : "w-full"
			}`}
		>
			{!embedded && (
				<div className="w-12 shrink-0 pt-0.5 text-[9px] tracking-widest text-primary/60 uppercase">
					Perm
				</div>
			)}
			<div className="min-w-0 flex-1 border border-border bg-card">
				<PermissionCardContent
					message={message}
					actionName={actionName}
					requesterSubagent={requesterSubagent}
				/>
				<PermissionCardControls message={message} onDecide={onDecide} />
			</div>
		</div>
	);
}
