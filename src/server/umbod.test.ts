import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
	root: `/tmp/hlid-umbod-reload-${Date.now()}`,
	servers: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
}));

vi.mock("#/lib/paths", () => ({
	APP_DIR: testState.root,
	expandTilde: (path: string) => path,
}));
vi.mock("#/server/config", () => ({
	loadConfig: () => ({
		umbod: { enabled: true, manifest_path: "umbod.toml" },
	}),
}));
vi.mock("@umbod/core", () => ({
	loadManifest: vi.fn(async () => ({
		server: { host: "127.0.0.1", port: 9090 },
	})),
	createUmbod: vi.fn(({ manifest }) => ({
		manifest,
		close: vi.fn(),
		fetch: vi.fn(),
		authorize: vi.fn(),
	})),
	findAdapterById: vi.fn(),
}));

Object.assign(globalThis, {
	Bun: {
		serve: vi.fn(() => {
			const server = { stop: vi.fn(), port: 9090 };
			testState.servers.push(server);
			return server;
		}),
	},
});

import { createUmbod, findAdapterById, loadManifest } from "@umbod/core";
import {
	authorizeHlidTool,
	bootstrapUmbod,
	closeUmbod,
	registerUmbodApprovalSession,
	saveUmbodManifest,
	umbodHookArtifacts,
} from "./umbod";

const manifest = (decision: "allow" | "approve") => `[env]
name = "hlid"
version = "1.0.0"
timeout = 300

[policy]
default_unknown = "${decision}"
approval_method = "cli"

[rules]
`;

describe("saveUmbodManifest", () => {
	afterEach(() => closeUmbod());

	it("reloads policy without rebinding the embedded server", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("allow"));
		await bootstrapUmbod();
		const original = testState.servers.at(-1);

		await saveUmbodManifest(manifest("approve"));

		expect(original?.stop).not.toHaveBeenCalled();
		expect(testState.servers).toHaveLength(1);
		expect(createUmbod).toHaveBeenCalledTimes(2);
	});

	it("routes hook approvals to the owning session and reuses the decision", async () => {
		mkdirSync(testState.root, { recursive: true });
		writeFileSync(join(testState.root, "umbod.toml"), manifest("approve"));
		const handler = vi.fn().mockResolvedValue("allow");
		registerUmbodApprovalSession("provider-session", handler);
		await bootstrapUmbod();
		const options = vi
			.mocked(createUmbod)
			.mock.calls.at(-1)?.[0] as unknown as {
			approvalPrompt: (
				call: Record<string, unknown>,
				reason: string,
			) => Promise<string>;
		};
		const call = {
			agent: "codex",
			tool: "Bash",
			command: "git status",
			inputs: { command: "git status" },
			workingDirectory: testState.root,
			timestamp: new Date().toISOString(),
			sessionId: "provider-session",
			toolUseId: "tool-1",
		};

		await expect(options.approvalPrompt(call, "matched rule")).resolves.toBe(
			"allow",
		);
		expect(handler).toHaveBeenCalledWith(call, "matched rule");
		await expect(
			authorizeHlidTool({
				agent: "codex",
				tool: "Bash",
				input: call.inputs,
				cwd: testState.root,
				sessionId: "db-session",
				toolUseId: "provider-rewritten-id",
				bypassApproval: false,
				prompt: vi.fn(),
			}),
		).resolves.toMatchObject({
			decision: "allow",
			policyDecision: "approve",
		});
	});
});

describe("umbodHookArtifacts", () => {
	afterEach(() => closeUmbod());

	it("never passes a zero timeout to any agent adapter", async () => {
		vi.mocked(loadManifest).mockResolvedValueOnce({
			server: { host: "127.0.0.1", port: 9090 },
			env: { timeout: 0 },
		} as never);
		const install = vi.fn((options: { timeoutSeconds: number }) => {
			void options;
			return {
				assets: [],
				config: { fileName: "settings.json", contents: {} },
			};
		});
		vi.mocked(findAdapterById).mockImplementation(
			(agent) => ({ id: agent, displayName: agent, install }) as never,
		);
		await bootstrapUmbod();

		await umbodHookArtifacts(["claude", "codex", "cursor", "gemini"], "wsl");

		expect(install).toHaveBeenCalledTimes(4);
		for (const [options] of install.mock.calls) {
			expect(options.timeoutSeconds).toBe(86_400);
		}
	});
});

afterEach(() => {
	if (testState.servers.length > 2) testState.servers.splice(0, 2);
});

process.on("exit", () =>
	rmSync(testState.root, { recursive: true, force: true }),
);
