import { describe, expect, it } from "vitest";
import { HlidConfigSchema } from "#/config";
import {
	configuredObsidianCapture,
	obsidianCaptureNotePath,
} from "./obsidianCapture";

describe("configuredObsidianCapture", () => {
	it("uses the configured PARA Inbox and optional template", () => {
		const config = HlidConfigSchema.parse({
			vault: {
				name: "Fornbok",
				style: "para",
				inbox: "0 Inbox/",
				raw: "Raw",
				save_to_obsidian_template: "Quick Capture",
			},
		});
		expect(configuredObsidianCapture(config.vault)).toEqual({
			kind: "inbox",
			label: "Inbox",
			folder: "0 Inbox",
			vaultName: "Fornbok",
			template: "Quick Capture",
		});
	});

	it("uses Raw for wiki workspaces and hides capture when it is empty", () => {
		const wiki = HlidConfigSchema.parse({
			vault: { name: "Wiki", style: "wiki", raw: "Raw" },
		});
		expect(configuredObsidianCapture(wiki.vault)?.label).toBe("Raw");

		const empty = HlidConfigSchema.parse({
			vault: { name: "No capture", style: "para" },
		});
		expect(configuredObsidianCapture(empty.vault)).toBeNull();
	});

	it("builds a timestamped collision-resistant Markdown path", () => {
		const destination = {
			kind: "inbox" as const,
			label: "Inbox" as const,
			folder: "0 Inbox",
			vaultName: "Fornbok",
			template: null,
		};
		expect(
			obsidianCaptureNotePath(
				destination,
				new Date(2026, 6, 20, 14, 35, 9, 42),
				"ab-cd_123456",
			),
		).toBe("0 Inbox/Hlid 2026-07-20 14-35-09-042 abcd1234.md");
	});
});
