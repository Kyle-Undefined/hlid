import * as z from "zod";
import {
	pushSessionIdSchema,
	pushTargetDeviceIdsSchema,
	type SessionNotificationMode,
	type SessionNotificationScope,
	sessionNotificationModeSchema,
	sessionNotificationScopeSchema,
} from "./pushNotificationSchemas";

const STORAGE_PREFIX = "hlid:raven-pending-notification:v1:";
const MAX_STORED_POLICY_CHARS = 2_048;

export type PendingSessionNotificationPolicy = {
	mode: Exclude<SessionNotificationMode, "default">;
	scope: SessionNotificationScope;
	targetDeviceIds: string[] | null;
};

const pendingSessionNotificationPolicySchema = z
	.object({
		version: z.literal(1),
		mode: sessionNotificationModeSchema.exclude(["default"]),
		scope: sessionNotificationScopeSchema,
		targetDeviceIds: pushTargetDeviceIdsSchema.nullable(),
	})
	.strict();

function storage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function pendingSessionNotificationPolicyStorageKey(
	sessionId: string,
): string | null {
	const parsed = pushSessionIdSchema.safeParse(sessionId);
	if (!parsed.success || parsed.data !== sessionId) return null;
	return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function loadPendingSessionNotificationPolicy(
	sessionId: string,
): PendingSessionNotificationPolicy | null {
	const key = pendingSessionNotificationPolicyStorageKey(sessionId);
	const target = storage();
	if (!key || !target) return null;
	try {
		const serialized = target.getItem(key);
		if (!serialized) return null;
		if (serialized.length > MAX_STORED_POLICY_CHARS) {
			target.removeItem(key);
			return null;
		}
		const parsed = pendingSessionNotificationPolicySchema.safeParse(
			JSON.parse(serialized),
		);
		if (!parsed.success) {
			target.removeItem(key);
			return null;
		}
		return {
			mode: parsed.data.mode,
			scope: parsed.data.scope,
			targetDeviceIds: parsed.data.targetDeviceIds,
		};
	} catch {
		try {
			target.removeItem(key);
		} catch {}
		return null;
	}
}

export function savePendingSessionNotificationPolicy(
	sessionId: string,
	policy: PendingSessionNotificationPolicy | null,
): boolean {
	const key = pendingSessionNotificationPolicyStorageKey(sessionId);
	const target = storage();
	if (!key || !target) return false;
	try {
		if (policy === null) {
			target.removeItem(key);
			return true;
		}
		const parsed = pendingSessionNotificationPolicySchema.safeParse({
			version: 1,
			...policy,
		});
		if (!parsed.success) return false;
		const serialized = JSON.stringify(parsed.data);
		if (serialized.length > MAX_STORED_POLICY_CHARS) return false;
		target.setItem(key, serialized);
		return true;
	} catch {
		return false;
	}
}

export function clearPendingSessionNotificationPolicy(sessionId: string): void {
	const key = pendingSessionNotificationPolicyStorageKey(sessionId);
	const target = storage();
	if (!key || !target) return;
	try {
		target.removeItem(key);
	} catch {}
}

export function samePendingSessionNotificationPolicy(
	left: PendingSessionNotificationPolicy,
	right: PendingSessionNotificationPolicy,
): boolean {
	const leftTargets =
		left.targetDeviceIds === null ? null : [...left.targetDeviceIds].sort();
	const rightTargets =
		right.targetDeviceIds === null ? null : [...right.targetDeviceIds].sort();
	return (
		left.mode === right.mode &&
		left.scope === right.scope &&
		JSON.stringify(leftTargets) === JSON.stringify(rightTargets)
	);
}
