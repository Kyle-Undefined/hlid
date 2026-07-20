import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkObsidianConnection,
	getObsidianConnectionSnapshot,
	getOrCheckObsidianConnection,
	resetObsidianConnectionCacheForTests,
} from "./obsidianConnectionCache";

beforeEach(resetObsidianConnectionCacheForTests);

describe("Obsidian connection startup cache", () => {
	it("reuses a successful connection snapshot until explicitly forced", async () => {
		const testConnection = vi.fn().mockResolvedValue({
			version: "1.12.7",
			vaultPath: "C:\\Vaults\\Fornbok",
		});

		await checkObsidianConnection("Fornbok", { testConnection });
		await checkObsidianConnection("Fornbok", { testConnection });

		expect(testConnection).toHaveBeenCalledOnce();
		expect(getObsidianConnectionSnapshot("Fornbok")).toMatchObject({
			state: "connected",
			connection: { version: "1.12.7" },
		});

		await checkObsidianConnection("Fornbok", {
			force: true,
			testConnection,
		});
		expect(testConnection).toHaveBeenCalledTimes(2);
	});

	it("keeps a failed startup result without retrying on route reads", async () => {
		const testConnection = vi
			.fn()
			.mockRejectedValue(new Error("Obsidian is unavailable"));

		await expect(
			checkObsidianConnection("Fornbok", { testConnection }),
		).rejects.toThrow("Obsidian is unavailable");
		await expect(
			getOrCheckObsidianConnection("Fornbok"),
		).resolves.toMatchObject({
			state: "failed",
			error: "Obsidian is unavailable",
		});
		expect(testConnection).toHaveBeenCalledOnce();
	});
});
