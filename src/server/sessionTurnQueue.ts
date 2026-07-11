export type QueuedTurn<TArgs extends unknown[]> = {
	args: TArgs;
	turnId?: string;
	resolve: () => void;
	reject: (error: Error) => void;
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

	cancel(turnId: string): boolean {
		const index = this.pending.findIndex((turn) => turn.turnId === turnId);
		if (index === -1) return false;
		const [removed] = this.pending.splice(index, 1);
		removed.resolve();
		return true;
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
