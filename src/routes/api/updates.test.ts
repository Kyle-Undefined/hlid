import { describe, expect, it, vi } from "vitest";
import { createUpdateRequestHandlers } from "./updates";

type Operations = Parameters<typeof createUpdateRequestHandlers>[0];

function operations(overrides: Partial<Operations> = {}): Operations {
	return {
		forbidden: vi.fn().mockReturnValue(null),
		localOnly: vi.fn().mockReturnValue(null),
		isLocal: vi.fn().mockReturnValue(true),
		getStatus: vi.fn().mockResolvedValue({ state: "idle" }),
		download: vi.fn().mockResolvedValue({ ok: true, downloaded: true }),
		apply: vi.fn().mockResolvedValue({ ok: true, applied: true }),
		prepareCli: vi.fn().mockResolvedValue({ command: "sudo npm update" }),
		applyCli: vi.fn().mockResolvedValue({ command: "npm update" }),
		...overrides,
	} as Operations;
}

function post(action: unknown): Request {
	return new Request("http://localhost/api/updates", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	});
}

describe("update request handlers", () => {
	it("rejects forbidden requests before reading or mutating anything", async () => {
		const forbidden = new Response("forbidden", { status: 403 });
		const ops = operations({ forbidden: vi.fn().mockReturnValue(forbidden) });
		const handlers = createUpdateRequestHandlers(ops);
		const request = new Request("http://localhost/api/updates", {
			method: "POST",
			body: "not json",
		});
		expect(await handlers.POST({ request })).toBe(forbidden);
		expect(ops.getStatus).not.toHaveBeenCalled();
		expect(ops.download).not.toHaveBeenCalled();
		expect(ops.apply).not.toHaveBeenCalled();
	});

	it("returns stable validation errors for malformed and unknown actions", async () => {
		const handlers = createUpdateRequestHandlers(operations());
		const malformed = await handlers.POST({
			request: new Request("http://localhost/api/updates", {
				method: "POST",
				body: "{",
			}),
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({
			ok: false,
			error: "invalid json",
		});

		const unknown = await handlers.POST({ request: post("remove") });
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({
			ok: false,
			error:
				"action must be one of: check, download, apply, prepare_cli, apply_cli",
		});
	});

	it("uses cached status for GET and forced status for manual checks", async () => {
		const ops = operations();
		const handlers = createUpdateRequestHandlers(ops);
		await handlers.GET({
			request: new Request("http://localhost/api/updates"),
		});
		await handlers.POST({ request: post("check") });
		expect(ops.getStatus).toHaveBeenNthCalledWith(1);
		expect(ops.getStatus).toHaveBeenNthCalledWith(2, { force: true });
	});

	it.each([
		"download",
		"apply",
	] as const)("runs only the requested %s operation", async (action) => {
		const ops = operations();
		const response = await createUpdateRequestHandlers(ops).POST({
			request: post(action),
		});
		expect(response.status).toBe(200);
		expect(ops.download).toHaveBeenCalledTimes(action === "download" ? 1 : 0);
		expect(ops.apply).toHaveBeenCalledTimes(action === "apply" ? 1 : 0);
	});

	it("keeps CLI mutations local and validates their target", async () => {
		const forbidden = Response.json({ ok: false }, { status: 403 });
		const remote = operations({
			localOnly: vi.fn().mockReturnValue(forbidden),
		});
		const remoteResponse = await createUpdateRequestHandlers(remote).POST({
			request: new Request("http://localhost/api/updates", {
				method: "POST",
				body: JSON.stringify({ action: "apply_cli", id: "codex" }),
			}),
		});
		expect(remoteResponse).toBe(forbidden);
		expect(remote.applyCli).not.toHaveBeenCalled();

		const local = operations();
		const missing = await createUpdateRequestHandlers(local).POST({
			request: post("prepare_cli"),
		});
		expect(missing.status).toBe(400);
		expect(local.prepareCli).not.toHaveBeenCalled();
	});

	it.each([
		"prepare_cli",
		"apply_cli",
	] as const)("dispatches the local %s action with the selected CLI", async (action) => {
		const ops = operations();
		const response = await createUpdateRequestHandlers(ops).POST({
			request: new Request("http://localhost/api/updates", {
				method: "POST",
				body: JSON.stringify({ action, id: "codex" }),
			}),
		});
		expect(response.status).toBe(200);
		expect(ops.prepareCli).toHaveBeenCalledTimes(
			action === "prepare_cli" ? 1 : 0,
		);
		expect(ops.applyCli).toHaveBeenCalledTimes(action === "apply_cli" ? 1 : 0);
	});

	it("rejects concurrent mutations and allows retry after completion", async () => {
		let finish!: () => void;
		const pending = new Promise<{ ok: true }>((resolve) => {
			finish = () => resolve({ ok: true });
		});
		const ops = operations({ apply: vi.fn().mockReturnValueOnce(pending) });
		const handlers = createUpdateRequestHandlers(ops);
		const first = handlers.POST({ request: post("apply") });
		const concurrent = await handlers.POST({ request: post("download") });
		expect(concurrent.status).toBe(409);
		expect(await concurrent.json()).toEqual({
			ok: false,
			error: "update action already in progress",
		});
		finish();
		await first;
		const retry = await handlers.POST({ request: post("download") });
		expect(retry.status).toBe(200);
		expect(ops.download).toHaveBeenCalledOnce();
	});

	it("clears the guard after failure and safely serializes thrown values", async () => {
		const ops = operations({
			apply: vi.fn().mockRejectedValueOnce("native failure"),
		});
		const handlers = createUpdateRequestHandlers(ops);
		const failed = await handlers.POST({ request: post("apply") });
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({
			ok: false,
			error: "native failure",
		});
		const retry = await handlers.POST({ request: post("download") });
		expect(retry.status).toBe(200);
	});
});
