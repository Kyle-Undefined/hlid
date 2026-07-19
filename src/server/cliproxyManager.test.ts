import { describe, expect, it } from "vitest";
import {
	checksumForAsset,
	managedCliProxyConfig,
	selectCliProxyReleaseAssets,
} from "./cliproxyManager";

describe("CLIProxy release verification", () => {
	it("selects the current Windows architecture and checksum manifest", () => {
		const selected = selectCliProxyReleaseAssets(
			{
				tag_name: "v7.2.88",
				assets: [
					{
						name: "CLIProxyAPI_7.2.88_windows_amd64.zip",
						browser_download_url: "https://example.test/amd64.zip",
					},
					{
						name: "CLIProxyAPI_7.2.88_windows_arm64.zip",
						browser_download_url: "https://example.test/arm64.zip",
					},
					{
						name: "checksums.txt",
						browser_download_url: "https://example.test/checksums.txt",
					},
				],
			},
			"arm64",
		);
		expect(selected.version).toBe("7.2.88");
		expect(selected.archive.name).toContain("windows_arm64.zip");
	});

	it("requires an exact SHA-256 entry for the selected archive", () => {
		const digest = "a".repeat(64);
		expect(
			checksumForAsset(
				`${digest}  CLIProxyAPI_7.2.88_windows_amd64.zip\n`,
				"CLIProxyAPI_7.2.88_windows_amd64.zip",
			),
		).toBe(digest);
		expect(() =>
			checksumForAsset(`${digest}  another.zip`, "wanted.zip"),
		).toThrow("checksum not found");
	});
});

describe("managed CLIProxy configuration", () => {
	it("binds loopback, disables management, and embeds only the private client key", () => {
		const yaml = managedCliProxyConfig("C:\\Hlid\\auth", "private-client-key");
		expect(yaml).toContain('host: "127.0.0.1"');
		expect(yaml).toContain('auth-dir: "C:\\\\Hlid\\\\auth"');
		expect(yaml).toContain('  - "private-client-key"');
		expect(yaml).toContain("allow-remote: false");
		expect(yaml).toContain("disable-control-panel: true");
		expect(yaml).toContain("usage-statistics-enabled: false");
	});
});
