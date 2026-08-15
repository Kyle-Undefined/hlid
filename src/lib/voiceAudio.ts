function writeAscii(view: DataView, offset: number, value: string): void {
	for (let index = 0; index < value.length; index++) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}

/** Decode a browser recording and normalize it to mono 16 kHz PCM for Whisper. */
export async function voiceAudioToWav(blob: Blob): Promise<Blob> {
	const context = new AudioContext();
	try {
		const decoded = await context.decodeAudioData(await blob.arrayBuffer());
		const sampleRate = 16_000;
		const frameCount = Math.max(1, Math.ceil(decoded.duration * sampleRate));
		const offline = new OfflineAudioContext(1, frameCount, sampleRate);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start();
		const rendered = await offline.startRendering();
		const samples = rendered.getChannelData(0);
		const buffer = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(buffer);
		writeAscii(view, 0, "RIFF");
		view.setUint32(4, 36 + samples.length * 2, true);
		writeAscii(view, 8, "WAVEfmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		writeAscii(view, 36, "data");
		view.setUint32(40, samples.length * 2, true);
		for (let index = 0; index < samples.length; index++) {
			const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
			view.setInt16(
				44 + index * 2,
				sample < 0 ? sample * 0x8000 : sample * 0x7fff,
				true,
			);
		}
		return new Blob([buffer], { type: "audio/wav" });
	} finally {
		void context.close();
	}
}
