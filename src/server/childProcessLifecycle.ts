import type { ChildProcess } from "node:child_process";

export function childIsRunning(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

export function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<boolean> {
	if (!childIsRunning(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("close", onClose);
			resolve(exited);
		};
		const onClose = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("close", onClose);
	});
}
