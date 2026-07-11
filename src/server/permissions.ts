import type {
	AskUserQuestionAnswers,
	AskUserQuestionMessage,
	AskUserQuestionNotes,
	PlanModeExitMessage,
	ServerMessage,
} from "./protocol";

type PermissionResolver = (
	approved: boolean,
	saveScope?: "session" | "local",
	denyMessage?: string,
) => void;

export type PermissionRequest = Extract<
	ServerMessage,
	{ type: "permission_request" }
>;

class PendingRequestManager<TRequest, TArgs extends unknown[]> {
	private resolvers = new Map<string, (...args: TArgs) => void>();
	private requests = new Map<string, TRequest>();

	protected registerRequest(
		id: string,
		request: TRequest,
		resolver: (...args: TArgs) => void,
		managerName: string,
		idLabel = "id",
	): void {
		if (this.resolvers.has(id)) {
			throw new Error(
				`${managerName}: duplicate registration for ${idLabel} "${id}"`,
			);
		}
		this.requests.set(id, request);
		this.resolvers.set(id, resolver);
	}

	delete(id: string): void {
		this.resolvers.delete(id);
		this.requests.delete(id);
	}

	protected completeRequest(
		id: string,
		args: TArgs,
		managerName: string,
	): void {
		const resolver = this.resolvers.get(id);
		if (!resolver) {
			console.warn(`${managerName}.complete: unknown id "${id}"`);
			return;
		}
		try {
			resolver(...args);
		} finally {
			this.delete(id);
		}
	}

	getPending(): TRequest[] {
		return Array.from(this.requests.values());
	}

	protected clearRequests(args: TArgs, managerName: string): void {
		const resolvers = Array.from(this.resolvers.values());
		this.resolvers.clear();
		this.requests.clear();
		for (const resolve of resolvers) {
			try {
				resolve(...args);
			} catch (error) {
				console.error(`${managerName}.clearAll: resolver threw:`, error);
			}
		}
	}
}

export class PermissionManager extends PendingRequestManager<
	PermissionRequest,
	[boolean, ("session" | "local")?, string?]
> {
	register(
		toolUseID: string,
		request: PermissionRequest,
		resolver: PermissionResolver,
	): void {
		this.registerRequest(
			toolUseID,
			request,
			resolver,
			"PermissionManager",
			"toolUseID",
		);
	}

	complete(
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	): void {
		this.completeRequest(
			id,
			[approved, saveScope, denyMessage],
			"PermissionManager",
		);
	}

	clearAll(): void {
		this.clearRequests([false], "PermissionManager");
	}
}

type AskUserQuestionResolver = (
	answers: AskUserQuestionAnswers,
	notes?: AskUserQuestionNotes,
) => void;

export class AskUserQuestionManager extends PendingRequestManager<
	AskUserQuestionMessage,
	[AskUserQuestionAnswers, AskUserQuestionNotes?]
> {
	register(
		id: string,
		request: AskUserQuestionMessage,
		resolver: AskUserQuestionResolver,
	): void {
		this.registerRequest(id, request, resolver, "AskUserQuestionManager");
	}

	complete(
		id: string,
		answers: AskUserQuestionAnswers,
		notes?: AskUserQuestionNotes,
	): void {
		this.completeRequest(id, [answers, notes], "AskUserQuestionManager");
	}

	clearAll(): void {
		this.clearRequests([{}], "AskUserQuestionManager");
	}
}

type PlanDecision = "approved" | "edited" | "cancelled";
type PlanModeExitResolver = (decision: PlanDecision, feedback?: string) => void;

export class PlanModeManager extends PendingRequestManager<
	PlanModeExitMessage,
	[PlanDecision, string?]
> {
	register(
		id: string,
		request: PlanModeExitMessage,
		resolver: PlanModeExitResolver,
	): void {
		this.registerRequest(id, request, resolver, "PlanModeManager");
	}

	complete(id: string, decision: PlanDecision, feedback?: string): void {
		this.completeRequest(id, [decision, feedback], "PlanModeManager");
	}

	clearAll(): void {
		this.clearRequests(["cancelled"], "PlanModeManager");
	}
}
