const NO_BODY_STATUSES = new Set([204, 205, 304]);
const MIN_GZIP_BYTES = 1_024;
type BodyChunk = Uint8Array<ArrayBuffer>;

function qualityForEncoding(header: string, encoding: string): number {
	let explicit: number | undefined;
	let wildcard: number | undefined;

	for (const entry of header.split(",")) {
		const [rawCoding, ...parameters] = entry.split(";");
		const coding = rawCoding?.trim().toLowerCase();
		if (!coding) continue;

		let quality = 1;
		for (const parameter of parameters) {
			const [rawName, rawValue] = parameter.split("=", 2);
			if (rawName?.trim().toLowerCase() !== "q") continue;
			const value = rawValue?.trim() ?? "";
			// RFC 9110 permits at most three fractional digits and a maximum of 1.
			if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) {
				quality = 0;
			} else {
				quality = Number(value);
			}
			break;
		}

		if (coding === encoding) {
			explicit = Math.max(explicit ?? 0, quality);
		} else if (coding === "*") {
			wildcard = Math.max(wildcard ?? 0, quality);
		}
	}

	return explicit ?? wildcard ?? 0;
}

function isCompressibleContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (type === "text/event-stream") return false;
	if (type.startsWith("text/")) return true;
	if (type.endsWith("+json") || type.endsWith("+xml")) return true;
	return (
		type === "application/json" ||
		type === "application/javascript" ||
		type === "application/x-javascript" ||
		type === "application/xml" ||
		type === "application/xhtml+xml" ||
		type === "application/manifest+json" ||
		type === "application/graphql-response+json" ||
		type === "image/svg+xml"
	);
}

function hasNoTransform(headers: Headers): boolean {
	return (headers.get("cache-control") ?? "")
		.split(",")
		.some((directive) => directive.trim().toLowerCase() === "no-transform");
}

function knownContentLength(headers: Headers): number | null {
	const value = headers.get("content-length")?.trim();
	if (!value || !/^\d+$/.test(value)) return null;
	const length = Number(value);
	return Number.isSafeInteger(length) ? length : null;
}

function appendVary(headers: Headers, field: string): void {
	const current = headers.get("vary");
	if (!current) {
		headers.set("vary", field);
		return;
	}
	const values = current.split(",").map((value) => value.trim());
	if (
		values.includes("*") ||
		values.some((value) => value.toLowerCase() === field.toLowerCase())
	) {
		return;
	}
	headers.set("vary", `${current}, ${field}`);
}

function responseWith(
	response: Response,
	body: BodyInit | null,
	headers: Headers,
): Response {
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function probeStream(
	body: ReadableStream<BodyChunk>,
	minimumBytes: number,
): Promise<{
	chunks: BodyChunk[];
	reader: ReadableStreamDefaultReader<BodyChunk>;
	done: boolean;
	bytes: number;
}> {
	const reader = body.getReader();
	const chunks: BodyChunk[] = [];
	let bytes = 0;
	while (bytes < minimumBytes) {
		const next = await reader.read();
		if (next.done) return { chunks, reader, done: true, bytes };
		chunks.push(next.value);
		bytes += next.value.byteLength;
	}
	return { chunks, reader, done: false, bytes };
}

function replayStream({
	chunks,
	reader,
	done,
}: {
	chunks: BodyChunk[];
	reader: ReadableStreamDefaultReader<BodyChunk>;
	done: boolean;
}): ReadableStream<BodyChunk> {
	let chunkIndex = 0;
	return new ReadableStream<BodyChunk>({
		async pull(controller) {
			if (chunkIndex < chunks.length) {
				controller.enqueue(chunks[chunkIndex++]);
				return;
			}
			if (done) {
				controller.close();
				return;
			}
			try {
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * Applies streaming gzip negotiation to an HTTP response when its media type
 * is textual. The source stream is piped directly through CompressionStream,
 * so large server-rendered or server-function responses are never buffered in
 * memory by this layer.
 */
export async function compressHttpResponse(
	request: Request,
	response: Response,
): Promise<Response> {
	if (
		request.method === "HEAD" ||
		response.body === null ||
		response.bodyUsed ||
		NO_BODY_STATUSES.has(response.status) ||
		response.status < 200
	) {
		return response;
	}

	// Byte ranges refer to the identity representation. Serving a transformed
	// stream here would make Content-Range and offsets incorrect.
	if (
		request.headers.has("range") ||
		response.status === 206 ||
		response.headers.has("content-range")
	) {
		return response;
	}
	if (
		response.headers.has("content-encoding") ||
		hasNoTransform(request.headers) ||
		hasNoTransform(response.headers) ||
		!isCompressibleContentType(response.headers.get("content-type"))
	) {
		return response;
	}
	const contentLength = knownContentLength(response.headers);
	if (contentLength !== null && contentLength < MIN_GZIP_BYTES) {
		return response;
	}

	const headers = new Headers(response.headers);
	appendVary(headers, "Accept-Encoding");
	const accepted = request.headers.get("accept-encoding") ?? "";
	if (
		qualityForEncoding(accepted, "gzip") <= 0 ||
		typeof CompressionStream === "undefined"
	) {
		return responseWith(response, response.body, headers);
	}

	let source = response.body;
	if (contentLength === null) {
		// Dynamic Response.json()/SSR bodies generally omit Content-Length. Peek
		// only until the threshold so tiny responses avoid gzip framing/CPU while
		// larger responses remain streamed instead of being fully buffered.
		const probe = await probeStream(source, MIN_GZIP_BYTES);
		source = replayStream(probe);
		if (probe.done && probe.bytes < MIN_GZIP_BYTES) {
			headers.set("content-length", String(probe.bytes));
			return responseWith(response, source, headers);
		}
	}

	headers.set("content-encoding", "gzip");
	headers.delete("content-length");
	headers.delete("accept-ranges");
	headers.delete("content-md5");
	headers.delete("content-digest");
	headers.delete("digest");
	const etag = headers.get("etag");
	if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);

	const compressed = source.pipeThrough(new CompressionStream("gzip"));
	return responseWith(response, compressed, headers);
}
