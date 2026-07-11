const MIB = 1024 * 1024;

// Multipart adds boundary and field metadata around the payload. Keep the
// allowance small and explicit so the accepted body cannot grow without the
// underlying file limit changing too.
export const MULTIPART_OVERHEAD_BYTES = MIB;
export const MAX_VOICE_AUDIO_BYTES = 100 * MIB;
export const MAX_VOICE_BODY_BYTES =
	MAX_VOICE_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES;

export function createConcurrencyGate(maxActive: number): {
	tryEnter: () => (() => void) | null;
} {
	let active = 0;
	return {
		tryEnter() {
			if (active >= maxActive) return null;
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
			};
		},
	};
}

export function contentLengthExceeds(
	request: Request,
	maxBytes: number,
): boolean {
	const raw = request.headers.get("content-length");
	if (raw === null) return false;
	const value = Number(raw);
	return !Number.isSafeInteger(value) || value < 0 || value > maxBytes;
}

export function payloadTooLarge(maxBytes: number): Response {
	return Response.json(
		{ error: "request_too_large", max_bytes: maxBytes },
		{ status: 413 },
	);
}

export async function readRequestBodyLimited(
	request: Request,
	maxBytes: number,
): Promise<
	{ ok: true; body: ArrayBuffer } | { ok: false; response: Response }
> {
	if (contentLengthExceeds(request, maxBytes)) {
		return { ok: false, response: payloadTooLarge(maxBytes) };
	}
	if (!request.body) return { ok: true, body: new ArrayBuffer(0) };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("request body exceeded limit").catch(() => {});
				return { ok: false, response: payloadTooLarge(maxBytes) };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new ArrayBuffer(total);
	const view = new Uint8Array(body);
	let offset = 0;
	for (const chunk of chunks) {
		view.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, body };
}
