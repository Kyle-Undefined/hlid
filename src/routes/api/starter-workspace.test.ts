import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenResponse } from "#/lib/originGate";
import { bootstrapStarterWorkspace } from "#/server/starterWorkspace";
import { makeRequest } from "#/test/routeTestKit";
import { handleStarterWorkspaceRequest } from "./starter-workspace";

vi.mock("#/lib/originGate");
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	realpath: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: vi.fn(),
}));
vi.mock("#/server/starterWorkspace", () => ({
	bootstrapStarterWorkspace: vi.fn(),
}));

const mockForbidden = vi.mocked(forbiddenResponse);
const mockBootstrap = vi.mocked(bootstrapStarterWorkspace);
const { realpath } = await import("node:fs/promises");
const { homedir } = await import("node:os");
const mockRealpath = vi.mocked(realpath);
const mockHomedir = vi.mocked(homedir);

function request(body: unknown = { parent_path: "/home/kyle" }) {
	return makeRequest("/api/starter-workspace", { method: "POST", json: body });
}

beforeEach(() => {
	vi.resetAllMocks();
	mockForbidden.mockReturnValue(null);
	mockHomedir.mockReturnValue("/home/kyle");
});

describe("POST /api/starter-workspace", () => {
	it("applies the origin gate before reading the request body", async () => {
		mockForbidden.mockReturnValue(new Response("Forbidden", { status: 403 }));
		const response = await handleStarterWorkspaceRequest(request());
		expect(response.status).toBe(403);
		expect(mockBootstrap).not.toHaveBeenCalled();
	});

	it("rejects malformed bootstrap requests", async () => {
		const response = await handleStarterWorkspaceRequest(
			request({ parent_path: "" }),
		);
		expect(response.status).toBe(400);
		expect(mockBootstrap).not.toHaveBeenCalled();
	});

	it("keeps the selected parent canonically inside the home directory", async () => {
		mockRealpath
			.mockResolvedValueOnce("/home/kyle")
			.mockResolvedValueOnce("/tmp/outside");
		const response = await handleStarterWorkspaceRequest(request());
		expect(response.status).toBe(403);
		expect(mockBootstrap).not.toHaveBeenCalled();
	});
});
