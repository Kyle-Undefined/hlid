import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenResponse } from "#/lib/originGate";
import { makeRequest } from "#/test/routeTestKit";
import {
	handleGetLocalAiSetup,
	handlePostLocalAiSetup,
} from "./local-ai-setup";

vi.mock("#/lib/originGate");

const operations = {
	snapshot: vi.fn(),
	mutate: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(forbiddenResponse).mockReturnValue(null);
});

describe("local AI setup API", () => {
	it("returns the reconciled snapshot through the guarded read endpoint", async () => {
		operations.snapshot.mockResolvedValue({ intent: null, steps: [] });
		const response = await handleGetLocalAiSetup(
			makeRequest("/api/local-ai-setup"),
			async () => operations,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ intent: null, steps: [] });
	});

	it("rejects malformed progress changes before invoking the coordinator", async () => {
		const response = await handlePostLocalAiSetup(
			makeRequest("/api/local-ai-setup", {
				method: "POST",
				json: { action: "delete-model" },
			}),
			async () => operations,
		);

		expect(response.status).toBe(400);
		expect(operations.mutate).not.toHaveBeenCalled();
	});

	it("persists only supported explicit workflow actions", async () => {
		operations.mutate.mockResolvedValue({ intent: { version: 1 }, steps: [] });
		const response = await handlePostLocalAiSetup(
			makeRequest("/api/local-ai-setup", {
				method: "POST",
				json: { action: "acknowledge", step: "ollama" },
			}),
			async () => operations,
		);

		expect(response.status).toBe(200);
		expect(operations.mutate).toHaveBeenCalledWith({
			action: "acknowledge",
			step: "ollama",
		});
	});
});
