import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mutateExtensionFn } from "#/lib/serverFns/extensions";
import type {
	ExtensionMutationInput,
	ExtensionMutationResult,
} from "#/server/extensionMutations";

export type ExtensionMutationStatus =
	| "succeeded"
	| "failed"
	| "busy"
	| "unmounted";

export type ExtensionTargetMutationState = {
	blocked: boolean;
	activeAction: ExtensionMutationInput["action"] | null;
};

export type ExtensionMutationFeedback = {
	operationId: number;
	targetId: string;
	kind: "success" | "error";
	message: string;
};

export type ExtensionMutationController = (
	input: ExtensionMutationInput,
	onSuccess?: () => void,
) => Promise<ExtensionMutationStatus>;

export type ExtensionMutationSurface = {
	mutate: ExtensionMutationController;
	stateFor: (targetId: string) => ExtensionTargetMutationState;
	dismissFeedback: (targetId: string, operationId: number) => void;
	hasActive: boolean;
	feedback: readonly ExtensionMutationFeedback[];
};

type ActiveMutation = {
	operationId: number;
	action: ExtensionMutationInput["action"];
};

type SuccessTimer = {
	operationId: number;
	timer: ReturnType<typeof setTimeout>;
};

function mutationTargetId(input: ExtensionMutationInput): string {
	return input.action === "add_marketplace" ? input.environmentId : input.id;
}

function mutationNotice(
	input: ExtensionMutationInput,
	result: ExtensionMutationResult,
): string {
	const subject = result.subject || result.pluginId || "Extension";
	let message: string;
	switch (result.action) {
		case "install":
			message = `${subject} installed in ${result.environmentLabel}.`;
			break;
		case "update":
		case "upgrade_marketplace":
			message = `${subject} updated in ${result.environmentLabel}.`;
			break;
		case "uninstall":
		case "remove_marketplace":
			message = `${subject} removed from ${result.environmentLabel}.`;
			break;
		case "set_enabled":
			message =
				input.action === "set_enabled"
					? `${subject} ${input.enabled ? "enabled" : "disabled"} in ${result.environmentLabel}.`
					: `${subject} updated in ${result.environmentLabel}.`;
			break;
		case "add_marketplace":
			message = `${subject} added in ${result.environmentLabel}.`;
			break;
	}
	return `${message}${result.warning ? ` ${result.warning}` : ""}`;
}

export function useExtensionMutationController({
	load,
	clearReview,
	isMounted,
}: {
	load: () => Promise<void>;
	clearReview: () => void;
	isMounted: () => boolean;
}): ExtensionMutationSurface {
	const operationIdRef = useRef(0);
	const activeRef = useRef(new Map<string, ActiveMutation>());
	const successTimersRef = useRef(new Map<string, SuccessTimer>());
	const [active, setActive] = useState<ReadonlyMap<string, ActiveMutation>>(
		() => new Map(),
	);
	const [feedbackByTarget, setFeedbackByTarget] = useState<
		ReadonlyMap<string, ExtensionMutationFeedback>
	>(() => new Map());

	const clearSuccessTimer = useCallback((targetId: string) => {
		const current = successTimersRef.current.get(targetId);
		if (!current) return;
		clearTimeout(current.timer);
		successTimersRef.current.delete(targetId);
	}, []);

	const clearTargetFeedback = useCallback(
		(targetId: string) => {
			clearSuccessTimer(targetId);
			if (!isMounted()) return;
			setFeedbackByTarget((current) => {
				if (!current.has(targetId)) return current;
				const next = new Map(current);
				next.delete(targetId);
				return next;
			});
		},
		[clearSuccessTimer, isMounted],
	);

	const publishFeedback = useCallback(
		(nextFeedback: ExtensionMutationFeedback) => {
			if (!isMounted()) return;
			clearSuccessTimer(nextFeedback.targetId);
			setFeedbackByTarget((current) => {
				const next = new Map(current);
				next.delete(nextFeedback.targetId);
				next.set(nextFeedback.targetId, nextFeedback);
				return next;
			});
			if (nextFeedback.kind !== "success") return;
			const timer = setTimeout(() => {
				const currentTimer = successTimersRef.current.get(
					nextFeedback.targetId,
				);
				if (currentTimer?.operationId !== nextFeedback.operationId) return;
				successTimersRef.current.delete(nextFeedback.targetId);
				if (!isMounted()) return;
				setFeedbackByTarget((current) => {
					const currentFeedback = current.get(nextFeedback.targetId);
					if (
						currentFeedback?.operationId !== nextFeedback.operationId ||
						currentFeedback.kind !== "success"
					) {
						return current;
					}
					const next = new Map(current);
					next.delete(nextFeedback.targetId);
					return next;
				});
			}, 5_000);
			successTimersRef.current.set(nextFeedback.targetId, {
				operationId: nextFeedback.operationId,
				timer,
			});
		},
		[clearSuccessTimer, isMounted],
	);
	const dismissFeedback = useCallback(
		(targetId: string, operationId: number) => {
			if (!isMounted()) return;
			const timer = successTimersRef.current.get(targetId);
			if (timer?.operationId === operationId) {
				clearSuccessTimer(targetId);
			}
			setFeedbackByTarget((current) => {
				if (current.get(targetId)?.operationId !== operationId) return current;
				const next = new Map(current);
				next.delete(targetId);
				return next;
			});
		},
		[clearSuccessTimer, isMounted],
	);

	useEffect(
		() => () => {
			for (const { timer } of successTimersRef.current.values()) {
				clearTimeout(timer);
			}
			successTimersRef.current.clear();
		},
		[],
	);

	const mutate = useCallback<ExtensionMutationController>(
		async (input, onSuccess) => {
			if (!isMounted()) return "unmounted";
			const targetId = mutationTargetId(input);
			if (activeRef.current.has(targetId)) return "busy";

			const operation: ActiveMutation = {
				operationId: ++operationIdRef.current,
				action: input.action,
			};
			activeRef.current.set(targetId, operation);
			setActive((current) => {
				const next = new Map(current);
				next.set(targetId, operation);
				return next;
			});
			clearTargetFeedback(targetId);

			try {
				let result: ExtensionMutationResult;
				try {
					({ result } = await mutateExtensionFn({ data: input }));
				} catch (cause) {
					if (!isMounted()) return "unmounted";
					publishFeedback({
						operationId: operation.operationId,
						targetId,
						kind: "error",
						message:
							cause instanceof Error
								? cause.message
								: "Extension action failed",
					});
					// Native CLIs can change provider state before returning a failure.
					// Always reconcile the catalog with a fresh provider snapshot.
					await load().catch(() => {});
					return "failed";
				}

				if (!isMounted()) return "unmounted";
				publishFeedback({
					operationId: operation.operationId,
					targetId,
					kind: "success",
					message: mutationNotice(input, result),
				});
				try {
					onSuccess?.();
				} catch (cause) {
					console.error("Extension mutation success callback failed", cause);
				}
				try {
					clearReview();
				} catch (cause) {
					console.error("Unable to clear the extension review", cause);
				}
				await load().catch(() => {});
				return "succeeded";
			} finally {
				if (
					activeRef.current.get(targetId)?.operationId === operation.operationId
				) {
					activeRef.current.delete(targetId);
				}
				if (isMounted()) {
					setActive((current) => {
						if (current.get(targetId)?.operationId !== operation.operationId) {
							return current;
						}
						const next = new Map(current);
						next.delete(targetId);
						return next;
					});
				}
			}
		},
		[clearReview, clearTargetFeedback, isMounted, load, publishFeedback],
	);

	const stateFor = useCallback(
		(targetId: string): ExtensionTargetMutationState => {
			const current = active.get(targetId);
			return {
				blocked: Boolean(current),
				activeAction: current?.action ?? null,
			};
		},
		[active],
	);
	const feedback = useMemo(
		() => Array.from(feedbackByTarget.values()),
		[feedbackByTarget],
	);

	return {
		mutate,
		stateFor,
		dismissFeedback,
		hasActive: active.size > 0,
		feedback,
	};
}
