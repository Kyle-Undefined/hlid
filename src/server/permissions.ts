import type {
	AskUserQuestionMessage,
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

export class PermissionManager {
	private resolvers = new Map<string, PermissionResolver>();
	private requests = new Map<string, PermissionRequest>();

	/** Store both the request data and its resolver. Called from canUseTool. */
	register(
		toolUseID: string,
		permReq: PermissionRequest,
		resolver: PermissionResolver,
	): void {
		if (this.resolvers.has(toolUseID)) {
			throw new Error(
				`PermissionManager: duplicate registration for toolUseID "${toolUseID}"`,
			);
		}
		this.requests.set(toolUseID, permReq);
		this.resolvers.set(toolUseID, resolver);
	}

	/** Remove a single permission entry once it has been resolved. */
	delete(toolUseID: string): void {
		this.resolvers.delete(toolUseID);
		this.requests.delete(toolUseID);
	}

	/** Invoke the resolver for a pending permission, then remove its data. */
	complete(
		id: string,
		approved: boolean,
		saveScope?: "session" | "local",
		denyMessage?: string,
	): void {
		if (!this.resolvers.has(id)) {
			console.warn(`PermissionManager.complete: unknown id "${id}"`);
			return;
		}
		try {
			this.resolvers.get(id)?.(approved, saveScope, denyMessage);
		} finally {
			this.delete(id);
		}
	}

	getPending(): PermissionRequest[] {
		return Array.from(this.requests.values());
	}

	/** Deny all pending permissions and clear both maps (used on abort). */
	clearAll(): void {
		const resolvers = Array.from(this.resolvers.values());
		this.resolvers.clear();
		this.requests.clear();
		for (const resolve of resolvers) {
			try {
				resolve(false);
			} catch (err) {
				console.error("PermissionManager.clearAll: resolver threw:", err);
			}
		}
	}
}

// ─── AskUserQuestionManager ───────────────────────────────────────────────────

type AskUserQuestionResolver = (selectedOption: string) => void;

export class AskUserQuestionManager {
	private resolvers = new Map<string, AskUserQuestionResolver>();
	private requests = new Map<string, AskUserQuestionMessage>();

	register(
		id: string,
		request: AskUserQuestionMessage,
		resolver: AskUserQuestionResolver,
	): void {
		if (this.resolvers.has(id)) {
			throw new Error(
				`AskUserQuestionManager: duplicate registration for id "${id}"`,
			);
		}
		this.requests.set(id, request);
		this.resolvers.set(id, resolver);
	}

	delete(id: string): void {
		this.resolvers.delete(id);
		this.requests.delete(id);
	}

	/** Invoke the resolver for a pending question, then remove its data. */
	complete(id: string, selectedOption: string): void {
		if (!this.resolvers.has(id)) {
			console.warn(`AskUserQuestionManager.complete: unknown id "${id}"`);
			return;
		}
		try {
			this.resolvers.get(id)?.(selectedOption);
		} finally {
			this.delete(id);
		}
	}

	getPending(): AskUserQuestionMessage[] {
		return Array.from(this.requests.values());
	}

	/** Resolve all pending questions with empty string and clear (used on abort/clear). */
	clearAll(): void {
		const resolvers = Array.from(this.resolvers.values());
		this.resolvers.clear();
		this.requests.clear();
		for (const resolve of resolvers) {
			try {
				resolve("");
			} catch (err) {
				console.error("AskUserQuestionManager.clearAll: resolver threw:", err);
			}
		}
	}
}

// ─── PlanModeManager ─────────────────────────────────────────────────────────

type PlanModeExitResolver = (
	decision: "approved" | "edited" | "cancelled",
	feedback?: string,
) => void;

export class PlanModeManager {
	private resolvers = new Map<string, PlanModeExitResolver>();
	private requests = new Map<string, PlanModeExitMessage>();

	register(
		id: string,
		request: PlanModeExitMessage,
		resolver: PlanModeExitResolver,
	): void {
		if (this.resolvers.has(id)) {
			throw new Error(`PlanModeManager: duplicate registration for id "${id}"`);
		}
		this.requests.set(id, request);
		this.resolvers.set(id, resolver);
	}

	delete(id: string): void {
		this.resolvers.delete(id);
		this.requests.delete(id);
	}

	complete(
		id: string,
		decision: "approved" | "edited" | "cancelled",
		feedback?: string,
	): void {
		if (!this.resolvers.has(id)) {
			console.warn(`PlanModeManager.complete: unknown id "${id}"`);
			return;
		}
		try {
			this.resolvers.get(id)?.(decision, feedback);
		} finally {
			this.delete(id);
		}
	}

	getPending(): PlanModeExitMessage[] {
		return Array.from(this.requests.values());
	}

	/** Cancel all pending plan exits (used on abort/clear). */
	clearAll(): void {
		const resolvers = Array.from(this.resolvers.values());
		this.resolvers.clear();
		this.requests.clear();
		for (const resolve of resolvers) {
			try {
				resolve("cancelled");
			} catch (err) {
				console.error("PlanModeManager.clearAll: resolver threw:", err);
			}
		}
	}
}
