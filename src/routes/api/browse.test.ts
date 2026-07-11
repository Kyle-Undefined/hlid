import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/config", () => ({ loadConfig: vi.fn() }));
vi.mock("#/lib/originGate", () => ({ forbiddenResponse: vi.fn(() => null) }));

import { forbiddenResponse } from "#/lib/originGate";
import { loadConfig } from "#/server/config";
import { handleBrowseRequest } from "./browse";

const mockLoadConfig = vi.mocked(loadConfig);
const mockForbiddenResponse = vi.mocked(forbiddenResponse);
let root: string;
let outside: string;

function request(path?: string, external = false): Request {
	const url = new URL("http://localhost/api/browse");
	if (path) url.searchParams.set("path", path);
	if (external) url.searchParams.set("external", "1");
	return new Request(url);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hlid-browse-root-"));
	outside = mkdtempSync(join(tmpdir(), "hlid-browse-outside-"));
	mkdirSync(join(root, "folder"));
	writeFileSync(join(root, "visible.md"), "ok");
	writeFileSync(join(root, ".hidden"), "hidden");
	mockForbiddenResponse.mockReturnValue(null);
	mockLoadConfig.mockReturnValue({
		vault: { path: root },
		server: { allow_external_agents: false },
	} as ReturnType<typeof loadConfig>);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("GET /api/browse", () => {
	it("lists the configured vault with directories first and hidden files omitted", async () => {
		const response = await handleBrowseRequest(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			path: realpathSync(root),
			entries: [
				{ name: "folder", isDirectory: true },
				{ name: "visible.md", isDirectory: false },
			],
		});
	});

	it("rejects sibling traversal and symlink escape", async () => {
		expect((await handleBrowseRequest(request(outside))).status).toBe(403);
		const link = join(root, "escape");
		symlinkSync(outside, link, "dir");
		expect((await handleBrowseRequest(request(link))).status).toBe(403);
	});

	it("does not honor external browsing unless it is enabled", async () => {
		expect((await handleBrowseRequest(request(outside, true))).status).toBe(
			403,
		);
		mockLoadConfig.mockReturnValue({
			vault: { path: root },
			server: { allow_external_agents: true },
		} as ReturnType<typeof loadConfig>);
		expect((await handleBrowseRequest(request(outside, true))).status).toBe(
			200,
		);
	});

	it("returns the origin gate response before reading configuration", async () => {
		mockForbiddenResponse.mockReturnValue(
			new Response("Forbidden", { status: 403 }),
		);
		const response = await handleBrowseRequest(request());
		expect(response.status).toBe(403);
		expect(mockLoadConfig).not.toHaveBeenCalled();
	});

	it("reports an inaccessible configured vault", async () => {
		rmSync(root, { recursive: true, force: true });
		const response = await handleBrowseRequest(request());
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Vault path not accessible",
		});
	});
});
