import { describe, expect, it } from "vitest";
import {
	formatVaultReferencedMessage,
	vaultReferenceQuery,
} from "./vaultReferences";

describe("vaultReferenceQuery", () => {
	it("opens from a standalone @ and keeps earlier prompt text", () => {
		expect(vaultReferenceQuery("compare this with @project plan")).toEqual({
			query: "project plan",
			start: 18,
			promptWithoutQuery: "compare this with ",
		});
	});

	it("does not treat an email address as a vault trigger", () => {
		expect(vaultReferenceQuery("send it to me@example.com")).toBeNull();
	});

	it("only uses the active line", () => {
		expect(vaultReferenceQuery("@old\nnew @ref")?.query).toBe("ref");
	});
});

describe("formatVaultReferencedMessage", () => {
	it("adds a durable reference footer", () => {
		expect(
			formatVaultReferencedMessage("Use these", [
				"Projects/Hlid.md",
				"Notes/API.md",
			]),
		).toBe(
			"Use these\n\nVault references:\n- Projects/Hlid.md\n- Notes/API.md",
		);
	});

	it("supports a reference-only turn", () => {
		expect(formatVaultReferencedMessage("", ["Projects/Hlid.md"])).toBe(
			"Vault references:\n- Projects/Hlid.md",
		);
	});

	it("persists Vault and Relic references as separate sections", () => {
		expect(
			formatVaultReferencedMessage(
				"Compare these",
				["Projects/Hlid.md"],
				["release-plan.html"],
			),
		).toBe(
			"Compare these\n\nVault references:\n- Projects/Hlid.md\n\nRelic references:\n- release-plan.html",
		);
	});

	it("supports a Relic-only turn", () => {
		expect(formatVaultReferencedMessage("", [], ["report.pdf"])).toBe(
			"Relic references:\n- report.pdf",
		);
	});
});
