import { describe, expect, it, vi } from "vitest";
// Import through the vite pipeline (not createRequire) so istanbul instruments
// the CJS module and its coverage lands in the report.
// @ts-expect-error — plain CJS module without type declarations
import { createPtyInputParser } from "./ptyInputParser.cjs";

function writeFrame(text: string): Buffer {
	const payload = Buffer.from(text);
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = 0x01;
	frame.writeUInt32BE(payload.length, 1);
	payload.copy(frame, 5);
	return frame;
}

describe("PTY input parser", () => {
	it("buffers split write frames and parses adjacent frames", () => {
		const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
		const parser = createPtyInputParser(() => pty);
		const first = writeFrame("hello");
		parser.handleInput(first.subarray(0, 3));
		expect(pty.write).not.toHaveBeenCalled();
		parser.handleInput(Buffer.concat([first.subarray(3), writeFrame("world")]));
		expect(pty.write.mock.calls).toEqual([["hello"], ["world"]]);
	});

	it("handles resize, kill, invalid bytes, and resize failures", () => {
		const pty = {
			write: vi.fn(),
			resize: vi.fn().mockImplementationOnce(() => {
				throw new Error("closed");
			}),
			kill: vi.fn(),
		};
		const parser = createPtyInputParser(() => pty);
		const resize = Buffer.from([0x02, 0, 120, 0, 40]);
		parser.handleInput(
			Buffer.concat([Buffer.from([0xff]), resize, resize, Buffer.from([0x03])]),
		);
		expect(pty.resize).toHaveBeenCalledTimes(2);
		expect(pty.resize).toHaveBeenLastCalledWith(120, 40);
		expect(pty.kill).toHaveBeenCalledOnce();
	});

	it("queues input until a PTY becomes available", () => {
		let pty: ReturnType<typeof makePty> | null = null;
		const parser = createPtyInputParser(() => pty);
		parser.handleInput(writeFrame("queued"));
		pty = makePty();
		parser.flushPending();
		expect(pty.write).toHaveBeenCalledWith("queued");
	});
});

function makePty() {
	return { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
}
