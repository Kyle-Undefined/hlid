export type QueuedTurn<TArgs extends unknown[]> = {
	args: TArgs;
	turnId?: string;
	resolve: () => void;
	reject: (error: Error) => void;
};

export type ExtractedQueuedTurn<TArgs extends unknown[]> = {
	turn: QueuedTurn<TArgs>;
	index: number;
};

/** Owns pending-turn ordering and promise settlement. */
export class SessionTurnQueue<TArgs extends unknown[]> {
	private pending: Array<QueuedTurn<TArgs>> = [];

	get length(): number {
		return this.pending.length;
	}

	enqueue(args: TArgs, turnId?: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.pending.push({ args, turnId, resolve, reject });
		});
	}

	shift(): QueuedTurn<TArgs> | undefined {
		return this.pending.shift();
	}

	peek(): QueuedTurn<TArgs> | undefined {
		return this.pending[0];
	}

	pendingTurnIds(): string[] {
		return this.pending
			.map((turn) => turn.turnId)
			.filter((id): id is string => id !== undefined);
	}

	pendingTurns(): ReadonlyArray<Pick<QueuedTurn<TArgs>, "args" | "turnId">> {
		return this.pending.map(({ args, turnId }) => ({ args, turnId }));
	}

	cancel(turnId: string): boolean {
		const extracted = this.extract(turnId);
		if (!extracted) return false;
		extracted.turn.resolve();
		return true;
	}

	/**
	 * Temporarily claim a pending turn for an out-of-band operation such as
	 * native provider steering. The caller either settles it after acceptance
	 * or restores it if the provider declines.
	 */
	extract(turnId: string): ExtractedQueuedTurn<TArgs> | undefined {
		const index = this.pending.findIndex((turn) => turn.turnId === turnId);
		if (index === -1) return undefined;
		const [turn] = this.pending.splice(index, 1);
		return { turn, index };
	}

	restore(extracted: ExtractedQueuedTurn<TArgs>): void {
		const index = Math.min(extracted.index, this.pending.length);
		this.pending.splice(index, 0, extracted.turn);
	}

	promote(turnId: string): boolean {
		const index = this.pending.findIndex((turn) => turn.turnId === turnId);
		if (index === -1) return false;
		if (index > 0) {
			const [promoted] = this.pending.splice(index, 1);
			this.pending.unshift(promoted);
		}
		return true;
	}

	resolveAll(): void {
		const dropped = this.pending.splice(0);
		for (const turn of dropped) turn.resolve();
	}
}
