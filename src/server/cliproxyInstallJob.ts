import type { CliProxyStatus } from "./cliproxyManager";

type CliProxyInstallJob = {
	status: CliProxyStatus;
	completion: Promise<void>;
};

/**
 * Observe the slow managed install without tying it to the browser request.
 * Completion work is attached in the background so failures never become unhandled
 * rejections and the manager's status remains the polling source of truth.
 */
export function observeCliProxyInstallJob(
	job: CliProxyInstallJob,
	onInstalled: () => Promise<void>,
	onError: (error: unknown) => void,
): CliProxyStatus {
	void job.completion.then(onInstalled).catch(onError);
	return job.status;
}
