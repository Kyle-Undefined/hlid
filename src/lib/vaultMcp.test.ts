/**
 * vaultMcp — delegation smoke tests.
 *
 * The vault helpers are thin wrappers around legacyProjectMcpAdapter, whose
 * behaviour matrix (missing files, disabled merging, idempotent toggles, key
 * preservation) is covered in agentMcp.test.ts. These tests only verify the
 * vault wrappers are wired to the adapter at the vault path.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readVaultMcpFile,
	readVaultMcpFileAsync,
	toggleVaultMcpFile,
	writeVaultMcpFile,
} from "./vaultMcp";

let vaultDir: string;

beforeEach(() => {
	vaultDir = mkdtempSync(join(tmpdir(), "hlid-vault-"));
});

afterEach(() => {
	rmSync(vaultDir, { recursive: true, force: true });
});

describe("vaultMcp adapter delegation", () => {
	it("write → read → toggle roundtrip operates on the vault path", () => {
		expect(readVaultMcpFile(vaultDir)).toEqual({ servers: [] });

		writeVaultMcpFile(vaultDir, { filesystem: { command: "npx" } });
		const written = JSON.parse(
			readFileSync(join(vaultDir, ".mcp.json"), "utf8"),
		);
		expect(written).toEqual({ mcpServers: { filesystem: { command: "npx" } } });

		toggleVaultMcpFile(vaultDir, "filesystem", true);
		expect(readVaultMcpFile(vaultDir)).toEqual({
			servers: [
				{ name: "filesystem", config: { command: "npx" }, disabled: true },
			],
		});
	});

	it("async read delegates to the adapter", async () => {
		writeVaultMcpFile(vaultDir, { brave: { command: "uvx" } });
		await expect(readVaultMcpFileAsync(vaultDir)).resolves.toEqual({
			servers: [{ name: "brave", config: { command: "uvx" }, disabled: false }],
		});
	});
});
