import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequestIP = vi.hoisted(() => vi.fn());
const effectivePeerIp = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start/server", () => ({ getRequestIP }));
vi.mock("#/server/auth", () => ({ effectivePeerIp }));
vi.mock("./token", () => ({ loadToken: () => "service-token" }));

import { cliUpdateAccessResponse, isCliUpdateUiRequest } from "./localRequest";

beforeEach(() => {
	vi.clearAllMocks();
	getRequestIP.mockReturnValue("127.0.0.1");
});

describe("CLI update UI request gate", () => {
	it("accepts a loopback browser", () => {
		effectivePeerIp.mockReturnValue("127.0.0.1");
		const request = new Request("http://localhost/api/updates");
		expect(isCliUpdateUiRequest(request)).toBe(true);
		expect(cliUpdateAccessResponse(request)).toBeNull();
		expect(effectivePeerIp).toHaveBeenCalledWith(
			request,
			"127.0.0.1",
			"service-token",
		);
	});

	it.each([
		"100.64.0.8",
		"fd7a:115c:a1e0::8",
	])("accepts the original Tailscale address %s forwarded by Hlid TLS", (peerIp) => {
		effectivePeerIp.mockReturnValue(peerIp);
		const request = new Request("https://hlid.example.ts.net/api/updates");
		expect(isCliUpdateUiRequest(request)).toBe(true);
		expect(cliUpdateAccessResponse(request)).toBeNull();
	});

	it("rejects an ordinary LAN address even when LAN access is enabled", async () => {
		effectivePeerIp.mockReturnValue("192.168.1.8");
		const response = cliUpdateAccessResponse(
			new Request("https://hlid.example/api/updates"),
		);
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({
			ok: false,
			error: "CLI updates can only be started locally or over Tailscale",
		});
	});
});
