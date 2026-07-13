/** Capacity of the per-session output ring buffer (bytes). */
const RING_BUFFER_BYTES = 100 * 1024; // 100 KB

/** Shared by TerminalSessionPool and ShellSessionPool for reconnect replay. */
export class RingBuffer {
	private buf: Buffer;
	private len = 0; // total bytes written (for pointer math)
	private cap: number;

	constructor(capacity = RING_BUFFER_BYTES) {
		this.cap = capacity;
		this.buf = Buffer.allocUnsafe(capacity);
	}

	// fallow-ignore-next-line unused-class-member -- Called through PtyPoolEntry.buffer in ptySessionPoolBase.
	push(data: Buffer): void {
		const src = data;
		if (src.length >= this.cap) {
			// Incoming chunk is larger than capacity — keep only the tail.
			src.copy(this.buf, 0, src.length - this.cap);
			this.len = this.cap;
			return;
		}
		const pos = this.len % this.cap;
		const tail = this.cap - pos;
		if (src.length <= tail) {
			src.copy(this.buf, pos);
		} else {
			// Wrap around: copy front portion to end, remainder to start.
			src.copy(this.buf, pos, 0, tail);
			src.copy(this.buf, 0, tail);
		}
		this.len += src.length;
	}

	/**
	 * Return the current buffer contents in order (oldest → newest).
	 * Returns a Buffer of at most `capacity` bytes.
	 */
	// fallow-ignore-next-line unused-class-member -- Called through PtyPoolEntry.buffer during PTY reattach.
	snapshot(): Buffer {
		if (this.len === 0) return Buffer.alloc(0);
		const used = Math.min(this.len, this.cap);
		const start = this.len % this.cap;
		if (this.len < this.cap) {
			// Buffer not yet full — data lives at [0, len)
			return Buffer.from(this.buf.subarray(0, used));
		}
		// Buffer full / wrapped — data starts at `start`
		const out = Buffer.allocUnsafe(this.cap);
		this.buf.copy(out, 0, start);
		this.buf.copy(out, this.cap - start, 0, start);
		return out;
	}
}
