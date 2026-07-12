import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenResponse } from "#/lib/originGate";
import { handlePostUmbod } from "./umbod";

vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn() }));

function post(body: unknown): Request {
	return new Request("http://localhost/api/umbod", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const saveUmbodManifest = vi.fn();
const umbodHookArtifacts = vi.fn();
const loadOperations = async () => ({
	saveUmbodManifest,
	umbodHookArtifacts,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(forbiddenResponse).mockReturnValue(null);
});

describe("POST /api/umbod", () => {
	it("applies the origin gate before parsing or dispatching", async () => {
		vi.mocked(forbiddenResponse).mockReturnValue(
			new Response("Forbidden", { status: 403 }),
		);
		const response = await handlePostUmbod(post("{"), loadOperations);

		expect(response.status).toBe(403);
		expect(saveUmbodManifest).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON and unknown actions", async () => {
		expect((await handlePostUmbod(post("{"), loadOperations)).status).toBe(400);
		const response = await handlePostUmbod(
			post({ action: "erase", source: "manifest" }),
			loadOperations,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unknown action" });
	});

	it("validates and dispatches hook generation", async () => {
		expect(
			(
				await handlePostUmbod(
					post({ action: "generate-hooks", agents: [], target: "linux" }),
					loadOperations,
				)
			).status,
		).toBe(400);
		umbodHookArtifacts.mockResolvedValue([{ agent: "claude" }]);

		const response = await handlePostUmbod(
			post({
				action: "generate-hooks",
				agents: ["claude"],
				target: "wsl",
			}),
			loadOperations,
		);

		expect(response.status).toBe(200);
		expect(umbodHookArtifacts).toHaveBeenCalledWith(["claude"], "wsl");
		expect(await response.json()).toEqual({
			artifacts: [{ agent: "claude" }],
		});
	});

	it("persists manifests and distinguishes validation from filesystem failures", async () => {
		expect(
			(await handlePostUmbod(post({ source: "allow" }), loadOperations)).status,
		).toBe(200);
		expect(saveUmbodManifest).toHaveBeenCalledWith("allow");

		saveUmbodManifest.mockRejectedValueOnce(new Error("invalid manifest"));
		expect(
			(await handlePostUmbod(post({ source: "bad" }), loadOperations)).status,
		).toBe(400);

		const diskError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		saveUmbodManifest.mockRejectedValueOnce(diskError);
		expect(
			(await handlePostUmbod(post({ source: "valid" }), loadOperations)).status,
		).toBe(500);
	});

	it("contains hook generation failures as server errors", async () => {
		umbodHookArtifacts.mockRejectedValueOnce(new Error("adapter failed"));
		const response = await handlePostUmbod(
			post({
				action: "generate-hooks",
				agents: ["claude"],
				target: "windows",
			}),
			loadOperations,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "adapter failed" });
	});
});
