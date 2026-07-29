type WorkerRpcResult<TResult> =
	| { ok: true; result: TResult }
	| { ok: false; error: string };

type WorkerRpcClientOptions<
	TInput,
	TRequest,
	TResponse extends { id: string },
	TResult,
> = {
	label: string;
	source: string;
	timeoutMs: number;
	buildRequest: (id: string, input: TInput) => TRequest;
	adaptResponse: (response: TResponse) => WorkerRpcResult<TResult>;
};

type PendingRequest<TResult> = {
	resolve: (result: TResult) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

/**
 * Reusable request/response lifecycle for Hlid's in-memory Bun workers.
 * Callers retain ownership of their wire protocol through explicit request and
 * response adapters.
 */
export class WorkerRpcClient<
	TInput,
	TRequest,
	TResponse extends { id: string },
	TResult,
> {
	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private readonly pending = new Map<string, PendingRequest<TResult>>();

	constructor(
		private readonly options: WorkerRpcClientOptions<
			TInput,
			TRequest,
			TResponse,
			TResult
		>,
	) {}

	run(input: TInput): Promise<TResult> {
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.close(
					`${this.options.label} worker timed out after ${this.options.timeoutMs}ms`,
				);
			}, this.options.timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.getWorker().postMessage(this.options.buildRequest(id, input));
		});
	}

	close(message: string): void {
		const active = this.worker;
		this.worker = null;
		this.rejectPending(message);
		active?.terminate();
	}

	private rejectPending(message: string): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timeout);
			request.reject(new Error(message));
		}
		this.pending.clear();
	}

	private getWorker(): Worker {
		if (this.worker) return this.worker;
		this.workerUrl ??= URL.createObjectURL(
			new Blob([this.options.source], { type: "text/javascript" }),
		);
		const next = new Worker(this.workerUrl, {
			type: "module",
			smol: true,
			ref: false,
		});
		next.addEventListener("message", (event: MessageEvent<TResponse>) => {
			const response = event.data;
			const request = this.pending.get(response.id);
			if (!request) return;
			this.pending.delete(response.id);
			clearTimeout(request.timeout);
			const adapted = this.options.adaptResponse(response);
			if (adapted.ok) request.resolve(adapted.result);
			else request.reject(new Error(adapted.error));
		});
		next.addEventListener("error", (event) => {
			if (this.worker !== next) return;
			const detail = event.message?.trim();
			this.close(
				`${this.options.label} worker failed${detail ? `: ${detail.slice(0, 300)}` : ""}`,
			);
		});
		next.addEventListener("close", () => {
			if (this.worker !== next) return;
			this.worker = null;
			this.rejectPending(`${this.options.label} worker closed unexpectedly`);
		});
		this.worker = next;
		return next;
	}
}
