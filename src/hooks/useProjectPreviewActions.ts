import { useCallback, useState } from "react";
import { applyProjectPreview } from "#/hooks/projectPreviewStore";
import {
	type ProjectPreviewSnapshot,
	restartProjectPreviewFn,
	stopProjectPreviewFn,
} from "#/lib/serverFns/projectPreviews";

export type ProjectPreviewAction = "restart" | "stop";

type ProjectPreviewActionTarget = Pick<
	ProjectPreviewSnapshot,
	"id" | "session_id"
>;

function actionErrorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function useProjectPreviewActions(
	preview: ProjectPreviewActionTarget | null | undefined,
) {
	const [pendingAction, setPendingAction] =
		useState<ProjectPreviewAction | null>(null);
	const [error, setError] = useState<string | null>(null);

	const clearError = useCallback(() => setError(null), []);
	const reportError = useCallback(
		(cause: unknown) => setError(actionErrorMessage(cause)),
		[],
	);
	const runAction = useCallback(
		async (action: ProjectPreviewAction): Promise<void> => {
			if (!preview) return;
			setPendingAction(action);
			clearError();
			try {
				const next =
					action === "restart"
						? await restartProjectPreviewFn({
								data: {
									sessionId: preview.session_id,
									previewId: preview.id,
								},
							})
						: await stopProjectPreviewFn({
								data: {
									sessionId: preview.session_id,
									previewId: preview.id,
								},
							});
				applyProjectPreview(next);
			} catch (cause) {
				reportError(cause);
			} finally {
				setPendingAction(null);
			}
		},
		[clearError, preview, reportError],
	);

	return {
		clearError,
		error,
		pendingAction,
		reportError,
		runAction,
	};
}
