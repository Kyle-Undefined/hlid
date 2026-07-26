import * as wsStore from "#/hooks/wsStore";
import { uid } from "#/lib/utils";
import { workflowResumePrompt } from "#/lib/workflowRuns";
import type { SubagentSnapshot } from "#/server/agentProvider";

export function stopNativeWorkflow(sessionId: string, taskId: string): void {
	wsStore.send({
		type: "workflow_control",
		action: "stop",
		task_id: taskId,
		session_id: sessionId,
	});
}

export function resumeNativeWorkflow(
	sessionId: string,
	workflow: SubagentSnapshot,
): void {
	wsStore.enqueueChat({
		id: uid(),
		text: workflowResumePrompt(workflow),
		session_id: sessionId,
	});
}
