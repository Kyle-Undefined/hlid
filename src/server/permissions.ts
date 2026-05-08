import type { ServerMessage } from "./protocol";

type PermissionResolver = (
	approved: boolean,
	saveScope?: "session" | "local",
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
	): void {
		if (!this.resolvers.has(id)) {
			console.warn(`PermissionManager.complete: unknown id "${id}"`);
			return;
		}
		try {
			this.resolvers.get(id)?.(approved, saveScope);
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
