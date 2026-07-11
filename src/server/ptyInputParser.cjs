"use strict";

function createPtyInputParser(getPty) {
	let inputBuf = Buffer.alloc(0);
	const pendingInput = [];

	function handleInput(chunk) {
		const pty = getPty();
		if (!pty) {
			pendingInput.push(chunk);
			return;
		}
		inputBuf = Buffer.concat([inputBuf, chunk]);
		while (inputBuf.length > 0) {
			const type = inputBuf[0];
			if (type === 0x01) {
				if (inputBuf.length < 5) return;
				const len = inputBuf.readUInt32BE(1);
				if (inputBuf.length < 5 + len) return;
				pty.write(new TextDecoder().decode(inputBuf.subarray(5, 5 + len)));
				inputBuf = inputBuf.subarray(5 + len);
				continue;
			}
			if (type === 0x02) {
				if (inputBuf.length < 5) return;
				try {
					pty.resize(inputBuf.readUInt16BE(1), inputBuf.readUInt16BE(3));
				} catch {}
				inputBuf = inputBuf.subarray(5);
				continue;
			}
			if (type === 0x03) {
				pty.kill();
				inputBuf = inputBuf.subarray(1);
				continue;
			}
			inputBuf = inputBuf.subarray(1);
		}
	}

	function flushPending() {
		for (const chunk of pendingInput.splice(0)) handleInput(chunk);
	}

	return { handleInput, flushPending };
}

module.exports = { createPtyInputParser };
