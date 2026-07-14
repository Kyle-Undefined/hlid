import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequestIP = vi.hoisted(() => vi.fn());
const effectivePeerIp = vi.hoisted(() => vi.fn());
const isLoopback = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start/server", () => ({ getRequestIP }));
vi.mock("#/server/auth", () => ({ effectivePeerIp, isLoopback }));
vi.mock("./token", () => ({ loadToken: () => "service-token" }));

import { isLocalUiRequest, localOnlyResponse } from "./localRequest";

beforeEach(() => {
	vi.clearAllMocks();
	getRequestIP.mockReturnValue("127.0.0.1");
});

describe("local UI request gate", () => {
	it("accepts a loopback browser", () => {
		effectivePeerIp.mockReturnValue("127.0.0.1");
		isLoopback.mockReturnValue(true);
		const request = new Request("http://localhost/api/updates");
		expect(isLocalUiRequest(request)).toBe(true);
		expect(localOnlyResponse(request)).toBeNull();
		expect(effectivePeerIp).toHaveBeenCalledWith(
			request,
			"127.0.0.1",
			"service-token",
		);
	});

	it("rejects the original remote address forwarded by Hlid TLS", async () => {
		effectivePeerIp.mockReturnValue("100.64.0.8");
		isLoopback.mockReturnValue(false);
		const response = localOnlyResponse(
			new Request("https://hlid.example/api/updates"),
		);
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({
			ok: false,
			error: "CLI updates can only be started from this computer",
		});
	});
});
