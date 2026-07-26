import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProjectPreviewLoopbackBridge,
	ProjectPreviewManager,
	parseWslIpv4Address,
	projectPreviewEnvironment,
	projectPreviewLaunch,
	resolveProjectPreviewCwd,
} from "./projectPreview";

const persist = async () => {};

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not allocate a test port.");
	}
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("ProjectPreviewManager", () => {
	const managers: ProjectPreviewManager[] = [];

	afterEach(async () => {
		await Promise.all(managers.map((manager) => manager.closeAll()));
		managers.length = 0;
	});

	it("owns a ready preview until the session stops it", async () => {
		const browserManager = {
			close: vi.fn(async () => {}),
			closeAll: vi.fn(async () => {}),
		};
		const manager = new ProjectPreviewManager({ persist, browserManager });
		managers.push(manager);
		const port = await freePort();
		const script =
			"require('node:http').createServer((_request,response)=>response.end('ready')).listen(" +
			port +
			",'127.0.0.1')";
		const preview = await manager.start({
			sessionId: "session-1",
			runtimeCwd: process.cwd(),
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
			port,
			readinessTimeoutSeconds: 5,
		});

		expect(preview).toMatchObject({
			session_id: "session-1",
			port,
			state: "ready",
			present: true,
			relay_url: expect.stringContaining(`/api/project-previews/${preview.id}`),
		});
		expect(manager.inspect("session-1").id).toBe(preview.id);
		expect(await manager.stop("session-1")).toMatchObject({
			id: preview.id,
			state: "stopped",
		});
		expect(browserManager.close).toHaveBeenCalledWith(preview.id);
	});

	it("restarts a preview on the same port after the old process releases it", async () => {
		const browserManager = {
			close: vi.fn(async () => {}),
			closeAll: vi.fn(async () => {}),
		};
		const manager = new ProjectPreviewManager({ persist, browserManager });
		managers.push(manager);
		const port = await freePort();
		const script =
			"require('node:http').createServer((_request,response)=>response.end('ready')).listen(" +
			port +
			",'127.0.0.1')";
		const first = await manager.start({
			sessionId: "restart-session",
			runtimeCwd: process.cwd(),
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
			port,
			readinessTimeoutSeconds: 5,
		});

		const restarted = await manager.restart("restart-session", first.id);

		expect(restarted).toMatchObject({
			session_id: "restart-session",
			port,
			state: "ready",
		});
		expect(restarted.id).not.toBe(first.id);
		expect(manager.inspect("restart-session", first.id)).toMatchObject({
			state: "stopped",
			stop_reason: "replaced",
		});
		expect(manager.inspect("restart-session").id).toBe(restarted.id);
	});

	it("rejects working directories outside the active workspace", async () => {
		const manager = new ProjectPreviewManager({ persist });
		managers.push(manager);
		await expect(
			manager.start({
				sessionId: "session-1",
				runtimeCwd: process.cwd(),
				workingDirectory: "..",
				command: "unused",
				port: await freePort(),
			}),
		).rejects.toThrow("cannot leave");
	});

	it("does not attach to a port owned by another process", async () => {
		const port = await freePort();
		const occupied = createServer();
		await new Promise<void>((resolve) =>
			occupied.listen(port, "127.0.0.1", () => resolve()),
		);
		const manager = new ProjectPreviewManager({ persist });
		managers.push(manager);
		await expect(
			manager.start({
				sessionId: "session-1",
				runtimeCwd: process.cwd(),
				command: "unused",
				port,
			}),
		).rejects.toThrow("already in use");
		await new Promise<void>((resolve) => occupied.close(() => resolve()));
	});

	it("expires a preview after the bounded safety lifetime", async () => {
		const manager = new ProjectPreviewManager({
			persist,
			lifetimeMs: 250,
		});
		managers.push(manager);
		const port = await freePort();
		const script =
			"require('node:http').createServer((_request,response)=>response.end('ready')).listen(" +
			port +
			",'127.0.0.1')";
		await manager.start({
			sessionId: "session-expiry",
			runtimeCwd: process.cwd(),
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
			port,
			readinessTimeoutSeconds: 5,
		});
		await expect
			.poll(() => manager.inspect("session-expiry").state, { timeout: 2_000 })
			.toBe("stopped");
		expect(manager.inspect("session-expiry").stop_reason).toBe(
			"lifetime_expired",
		);
	});
});

describe("Project Preview Windows and WSL launch plans", () => {
	it("prevents preview executables from self-installing over Hlid", () => {
		expect(
			projectPreviewEnvironment({
				PATH: "C:\\Windows",
				WSLENV: "PATH/l:HLID_SKIP_SELF_INSTALL/w:OTHER/u",
			}),
		).toEqual({
			PATH: "C:\\Windows",
			HLID_SKIP_SELF_INSTALL: "1",
			WSLENV: "HLID_SKIP_SELF_INSTALL/u:PATH/l:OTHER/u",
		});
	});

	it("selects the first non-loopback WSL IPv4 address", () => {
		expect(parseWslIpv4Address("127.0.0.1 172.28.91.42 2001:db8::1\n")).toBe(
			"172.28.91.42",
		);
		expect(parseWslIpv4Address("127.0.0.1 ::1")).toBeUndefined();
	});

	it("bridges a loopback port to a reachable preview target", async () => {
		const targetPort = await freePort();
		const localPort = await freePort();
		const target = createServer((socket) => socket.end("ready"));
		await new Promise<void>((resolve, reject) => {
			target.once("error", reject);
			target.listen(targetPort, "127.0.0.1", () => resolve());
		});
		const bridge = await createProjectPreviewLoopbackBridge(
			localPort,
			"127.0.0.1",
			targetPort,
		);

		const response = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({
				host: "127.0.0.1",
				port: localPort,
			});
			let value = "";
			socket.on("data", (chunk) => {
				value += chunk.toString("utf8");
			});
			socket.once("end", () => resolve(value));
			socket.once("error", reject);
		});

		expect(response).toBe("ready");
		await bridge.close();
		await new Promise<void>((resolve) => target.close(() => resolve()));
	});

	it("uses a native Windows shell and task workspace", () => {
		expect(
			projectPreviewLaunch("bun run dev", "C:\\Code\\Hlid", "win32"),
		).toEqual({
			executable: "bun run dev",
			args: [],
			cwd: "C:\\Code\\Hlid",
			shell: true,
			detached: false,
		});
		expect(
			resolveProjectPreviewCwd("C:\\Code\\Hlid", "apps\\web", "win32"),
		).toBe("C:\\Code\\Hlid\\apps\\web");
	});

	it("launches a WSL UNC workspace inside the owning distro", () => {
		const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\kyle\\hlid\\apps\\web";
		expect(
			resolveProjectPreviewCwd(
				"\\\\wsl.localhost\\Ubuntu\\home\\kyle\\hlid",
				"apps/web",
				"win32",
			),
		).toBe(cwd);
		expect(projectPreviewLaunch("bun run dev", cwd, "win32")).toEqual({
			executable: "wsl.exe",
			args: [
				"-d",
				"Ubuntu",
				"--cd",
				"/home/kyle/hlid/apps/web",
				"--",
				"sh",
				"-lc",
				"bun run dev",
			],
			shell: false,
			detached: false,
		});
	});

	it("rejects WSL traversal outside the active workspace", () => {
		expect(() =>
			resolveProjectPreviewCwd(
				"\\\\wsl$\\Ubuntu\\home\\kyle\\hlid",
				"../other",
				"win32",
			),
		).toThrow("cannot leave");
	});
});
