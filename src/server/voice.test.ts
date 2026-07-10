import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_CONFIG } from "../config";
import { VoiceModelManager } from "./voice";

describe("VoiceModelManager", () => {
	it("stays disabled without affecting server startup", async () => {
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		await manager.initialize();
		expect(manager.status()).toEqual({ state: "disabled", model: "" });
	});

	it("reports setup required when enabled without a selected model", async () => {
		const manager = new VoiceModelManager(
			{ ...DEFAULT_VOICE_CONFIG, enabled: true },
			null,
		);
		await manager.initialize();
		expect(manager.status().state).toBe("unconfigured");
	});

	it("catalog exposes the curated recommended model", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
		const manager = new VoiceModelManager(DEFAULT_VOICE_CONFIG, null);
		const models = await manager.models();
		expect(models.find((model) => model.id === "base")?.recommended).toBe(true);
		expect(
			models.every((model) => model.downloadUrl.startsWith("https://")),
		).toBe(true);
	});
});
