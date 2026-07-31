import { useEffect, useSyncExternalStore } from "react";
import {
	getProjectPreviewFn,
	type ProjectPreviewSnapshot,
} from "#/lib/serverFns/projectPreviews";

const previews = new Map<string, ProjectPreviewSnapshot>();
const presentationRequests = new Map<string, number>();
const unavailableSessions = new Set<string>();
const pendingReads = new Map<string, Promise<ProjectPreviewSnapshot | null>>();
const authorityGenerations = new Map<string, number>();
const subscribers = new Set<() => void>();
let revision = 0;

function emit(): void {
	revision++;
	for (const subscriber of subscribers) subscriber();
}

function authorityGeneration(sessionId: string): number {
	return authorityGenerations.get(sessionId) ?? 0;
}

function advanceAuthorityGeneration(sessionId: string): void {
	authorityGenerations.set(sessionId, authorityGeneration(sessionId) + 1);
}

export function applyProjectPreview(preview: ProjectPreviewSnapshot): void {
	advanceAuthorityGeneration(preview.session_id);
	previews.set(preview.session_id, preview);
	unavailableSessions.delete(preview.session_id);
	emit();
}

export function clearProjectPreview(sessionId: string): void {
	// Invalidate an older manager read even when there is no cached state to
	// delete. A reconnect's authoritative null must win transport-order races.
	advanceAuthorityGeneration(sessionId);
	const previewChanged = previews.delete(sessionId);
	const presentationChanged = presentationRequests.delete(sessionId);
	const unavailableChanged = unavailableSessions.delete(sessionId);
	const changed = previewChanged || presentationChanged || unavailableChanged;
	if (changed) emit();
}

export function requestProjectPreviewPresentation(sessionId: string): void {
	presentationRequests.set(
		sessionId,
		(presentationRequests.get(sessionId) ?? 0) + 1,
	);
	emit();
}

function subscribe(subscriber: () => void): () => void {
	subscribers.add(subscriber);
	return () => subscribers.delete(subscriber);
}

function snapshot(): number {
	return revision;
}

function readProjectPreview(
	sessionId: string,
): Promise<ProjectPreviewSnapshot | null> {
	const existing = pendingReads.get(sessionId);
	if (existing) return existing;
	const pending = Promise.resolve()
		.then(() => getProjectPreviewFn({ data: sessionId }))
		.finally(() => {
			if (pendingReads.get(sessionId) === pending) {
				pendingReads.delete(sessionId);
			}
		});
	pendingReads.set(sessionId, pending);
	return pending;
}

export function useProjectPreview(
	sessionId: string,
): ProjectPreviewSnapshot | null {
	useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => {
		if (!sessionId) return;
		if (previews.has(sessionId)) return;
		const readGeneration = authorityGeneration(sessionId);
		let cancelled = false;
		void readProjectPreview(sessionId)
			.then((preview) => {
				if (cancelled || authorityGeneration(sessionId) !== readGeneration) {
					return;
				}
				if (preview) {
					applyProjectPreview(preview);
				} else {
					unavailableSessions.add(sessionId);
					emit();
				}
			})
			.catch(() => {
				// No active preview and transient API misses both leave the live
				// WebSocket-owned snapshot unchanged.
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);
	return previews.get(sessionId) ?? null;
}

export function useProjectPreviewUnavailable(sessionId: string): boolean {
	useSyncExternalStore(subscribe, snapshot, snapshot);
	return unavailableSessions.has(sessionId);
}

export function useProjectPreviewPresentationRequest(
	sessionId: string,
): number {
	useSyncExternalStore(subscribe, snapshot, snapshot);
	return presentationRequests.get(sessionId) ?? 0;
}
