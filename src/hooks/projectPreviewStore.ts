import { useEffect, useSyncExternalStore } from "react";
import {
	getProjectPreviewFn,
	type ProjectPreviewSnapshot,
} from "#/lib/serverFns/projectPreviews";

const previews = new Map<string, ProjectPreviewSnapshot>();
const presentationRequests = new Map<string, number>();
const unavailableSessions = new Set<string>();
const pendingReads = new Map<string, Promise<ProjectPreviewSnapshot | null>>();
const subscribers = new Set<() => void>();
let revision = 0;

function emit(): void {
	revision++;
	for (const subscriber of subscribers) subscriber();
}

export function applyProjectPreview(preview: ProjectPreviewSnapshot): void {
	previews.set(preview.session_id, preview);
	unavailableSessions.delete(preview.session_id);
	emit();
}

export function clearProjectPreview(sessionId: string): void {
	const changed =
		previews.delete(sessionId) ||
		presentationRequests.delete(sessionId) ||
		unavailableSessions.delete(sessionId);
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
		let cancelled = false;
		void readProjectPreview(sessionId)
			.then((preview) => {
				if (cancelled) return;
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
