import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAutostart,
	getInstallPaths,
	installAutostart,
	openInstallDir,
	shutdown,
	uninstallAutostart,
} from "#/lib/lifecycle";
import { forbiddenResponse } from "#/lib/originGate";
import { handleGetLifecycle, handlePostLifecycle } from "./lifecycle";

vi.mock("#/lib/lifecycle", () => ({
	getAutostart: vi.fn(),
	getInstallPaths: vi.fn(),
	installAutostart: vi.fn(),
	openInstallDir: vi.fn(),
	shutdown: vi.fn(),
	uninstallAutostart: vi.fn(),
}));

vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn() }));

function request(action?: string): Request {
	return new Request("http://localhost/api/lifecycle", {
		method: action ? "POST" : "GET",
		headers: { "content-type": "application/json" },
		body: action ? JSON.stringify({ action }) : undefined,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(forbiddenResponse).mockReturnValue(null);
	vi.mocked(getAutostart).mockResolvedValue({
		ok: true,
		data: { enabled: true, supported: true },
	});
	vi.mocked(getInstallPaths).mockReturnValue({
		exe: "C:/hlid/hlid.exe",
		dir: "C:/hlid",
		canonical_exe: "C:/hlid/hlid.exe",
		canonical_dir: "C:/hlid",
		is_canonical: true,
	});
});

describe("lifecycle route handlers", () => {
	it("combines autostart and install state", async () => {
		const response = await handleGetLifecycle(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { enabled: true, supported: true, install: { dir: "C:/hlid" } },
		});
	});

	it("contains lifecycle state lookup failures", async () => {
		vi.mocked(getAutostart).mockRejectedValueOnce(new Error("registry failed"));
		const response = await handleGetLifecycle(request());
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Failed to read lifecycle state",
		});
	});

	it.each([
		["install", installAutostart],
		["uninstall", uninstallAutostart],
		["open_install_dir", openInstallDir],
	])("dispatches the %s action", async (action, operation) => {
		vi.mocked(operation).mockResolvedValueOnce({ ok: true });
		const response = await handlePostLifecycle(request(action));
		expect(response.status).toBe(200);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("dispatches shutdown synchronously", async () => {
		vi.mocked(shutdown).mockReturnValueOnce({ ok: true });
		const response = await handlePostLifecycle(request("shutdown"));
		expect(response.status).toBe(200);
		expect(shutdown).toHaveBeenCalledOnce();
	});

	it("rejects malformed JSON and unknown actions", async () => {
		const malformed = new Request("http://localhost/api/lifecycle", {
			method: "POST",
			body: "{",
		});
		expect((await handlePostLifecycle(malformed)).status).toBe(400);
		expect((await handlePostLifecycle(request("erase"))).status).toBe(400);
		expect(installAutostart).not.toHaveBeenCalled();
	});

	it("contains action failures behind a stable server response", async () => {
		vi.mocked(installAutostart).mockRejectedValueOnce(
			new Error("registry denied"),
		);
		const response = await handlePostLifecycle(request("install"));
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Lifecycle action failed",
		});
	});

	it("applies the origin gate before any lifecycle operation", async () => {
		vi.mocked(forbiddenResponse).mockReturnValueOnce(
			new Response("Forbidden", { status: 403 }),
		);
		expect((await handlePostLifecycle(request("shutdown"))).status).toBe(403);
		expect(shutdown).not.toHaveBeenCalled();
	});
});
