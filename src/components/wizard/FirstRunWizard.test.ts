import { describe, expect, it } from "vitest";
import {
	buildFirstRunConfig,
	detectVaultStructure,
	vaultNameFromPath,
} from "./FirstRunWizard";
import type { StructureState } from "./WizardSteps";

const structure: StructureState = {
	vaultName: "Knowledge",
	vaultPath: "/vault",
	vaultStyle: "para",
	inbox: "00 Inbox",
	projects: "10 Projects",
	areas: "20 Areas",
	resources: "30 Resources",
	archive: "40 Archive",
	rawFolder: "",
	wikiFolder: "",
	outputs: "Outputs",
	skills: "Skills",
	memory: "Memory",
	permissionMode: "acceptEdits",
	theme: "dark",
};

describe("first-run configuration policy", () => {
	it("detects PARA folders without confusing files for absent values", () => {
		expect(
			detectVaultStructure([
				{ name: "projects-overview.md", isDirectory: false },
				{ name: "00 Inbox", isDirectory: true },
				{ name: "10 Projects", isDirectory: true },
				{ name: "20 Areas", isDirectory: true },
				{ name: "30 Resources", isDirectory: true },
				{ name: "40 Archive", isDirectory: true },
			]),
		).toMatchObject({
			vaultStyle: "para",
			inbox: "00 Inbox",
			projects: "10 Projects",
			areas: "20 Areas",
			resources: "30 Resources",
			archive: "40 Archive",
		});
	});

	it("detects wiki-style vaults", () => {
		expect(
			detectVaultStructure([
				{ name: "Raw", isDirectory: true },
				{ name: "Wiki", isDirectory: true },
			]),
		).toMatchObject({
			vaultStyle: "wiki",
			rawFolder: "Raw",
			wikiFolder: "Wiki",
		});
	});

	it("builds a complete schema-compatible configuration", () => {
		const config = buildFirstRunConfig(structure);
		expect(config).toMatchObject({
			vault: {
				name: "Knowledge",
				path: "/vault",
				projects: "10 Projects",
			},
			claude: { permission_mode: "acceptEdits" },
			ui: { theme: "dark" },
			attachments: { max_bytes: 25 * 1024 * 1024 },
			voice: { enabled: false },
		});
	});

	it("derives a vault name from POSIX and Windows paths", () => {
		expect(vaultNameFromPath("/home/kyle/My Vault")).toBe("My Vault");
		expect(vaultNameFromPath("C:\\Users\\Kyle\\My Vault")).toBe("My Vault");
		expect(vaultNameFromPath("/")).toBeNull();
	});
});
