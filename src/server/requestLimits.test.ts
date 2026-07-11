import { describe, expect, it } from "vitest";
import {
	contentLengthExceeds,
	createConcurrencyGate,
	readRequestBodyLimited,
} from "./requestLimits";

describe("request body limits", () => {
	it("bounds concurrent admission and releases idempotently", () => {
		const gate = createConcurrencyGate(1);
		const release = gate.tryEnter();
		expect(release).not.toBeNull();
		expect(gate.tryEnter()).toBeNull();
		release?.();
		release?.();
		expect(gate.tryEnter()).not.toBeNull();
	});

	it("rejects invalid and oversized content-length values", () => {
		expect(
			contentLengthExceeds(
				new Request("http://localhost", {
					headers: { "content-length": "not-a-number" },
				}),
				10,
			),
		).toBe(true);
		expect(
			contentLengthExceeds(
				new Request("http://localhost", {
					headers: { "content-length": "11" },
				}),
				10,
			),
		).toBe(true);
	});

	it("bounds chunked bodies even without content-length", async () => {
		const request = new Request("http://localhost", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(6));
					controller.enqueue(new Uint8Array(5));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);

		const result = await readRequestBodyLimited(request, 10);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(413);
	});

	it("returns an exact bounded body", async () => {
		const request = new Request("http://localhost", {
			method: "POST",
			body: "hello",
		});
		const result = await readRequestBodyLimited(request, 5);
		expect(result.ok).toBe(true);
		if (result.ok) expect(new TextDecoder().decode(result.body)).toBe("hello");
	});
});
