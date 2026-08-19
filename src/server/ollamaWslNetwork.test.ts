import { describe, expect, it, vi } from "vitest";
import type { runBoundedProcess } from "#/lib/process";
import {
	isCanonicalIpv4Address,
	isUsableWslNatIpv4Address,
	OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
	OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
	resolveOllamaWslNetwork,
} from "./ollamaWslNetwork";

function runner(
	results: Array<{ output: string; code: number | null } | Error>,
) {
	return vi.fn(async (..._args: Parameters<typeof runBoundedProcess>) => {
		const result = results.shift();
		if (result instanceof Error) throw result;
		return result ?? { output: "", code: 0 };
	});
}

function windowsAdapterOutput(
	address: string,
	overrides: Partial<{
		prefixLength: number;
		interfaceAlias: string;
		adapterName: string;
		interfaceDescription: string;
		interfaceIndex: number;
		status: string;
	}> = {},
): string {
	return `HLID_WSL_ADAPTER=${JSON.stringify({
		address,
		prefixLength: 20,
		interfaceAlias: "vEthernet (WSL (Hyper-V firewall))",
		adapterName: "vEthernet (WSL (Hyper-V firewall))",
		interfaceDescription: "Hyper-V Virtual Ethernet Adapter #2",
		interfaceIndex: 42,
		status: "Up",
		...overrides,
	})}\n`;
}

describe("Ollama WSL networking", () => {
	it("uses loopback for the exact distro in mirrored mode", async () => {
		const runProcess = runner([{ output: "mirrored\n", code: 0 }]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu-24.04", {
				platform: "win32",
				runProcess,
			}),
		).resolves.toEqual({
			ready: true,
			distro: "Ubuntu-24.04",
			mode: "mirrored",
			windowsHostAddress: "127.0.0.1",
			addressSource: "loopback",
		});
		expect(runProcess).toHaveBeenCalledOnce();
		expect(runProcess).toHaveBeenCalledWith(
			"wsl.exe",
			["-d", "Ubuntu-24.04", "--exec", "/usr/bin/wslinfo", "--networking-mode"],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: "WSL networking mode probe timed out",
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
	});

	it("uses a Windows-owned WSL address corroborated by the exact distro NAT route", async () => {
		const runProcess = runner([
			{ output: "warning from WSL\r\nNAT\r\n", code: 0 },
			{ output: windowsAdapterOutput("172.29.176.1"), code: 0 },
			{
				output:
					"default via 999.1.2.3 dev bad\ndefault via 172.29.176.1 dev eth0 proto kernel\n",
				code: 0,
			},
		]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess,
			}),
		).resolves.toEqual({
			ready: true,
			distro: "Ubuntu",
			mode: "nat",
			windowsHostAddress: "172.29.176.1",
			addressSource: "default_ipv4_gateway",
		});
		expect(runProcess).toHaveBeenNthCalledWith(
			2,
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: "Windows WSL adapter probe timed out",
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
		const encodedScript = runProcess.mock.calls[1]?.[1]?.[3] ?? "";
		const script = Buffer.from(encodedScript, "base64").toString("utf16le");
		expect(script).toContain("Get-NetAdapter");
		expect(script).toContain("Hyper-V Virtual Ethernet Adapter");
		expect(script).toContain(
			"-AddressFamily IPv4 -Type Unicast -AddressState Preferred",
		);
		expect(runProcess).toHaveBeenNthCalledWith(
			3,
			"wsl.exe",
			[
				"-d",
				"Ubuntu",
				"--exec",
				"/usr/sbin/ip",
				"-4",
				"route",
				"show",
				"default",
			],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: "WSL default route probe timed out",
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
	});

	it("rejects unsafe distro names before invoking wsl.exe", async () => {
		const runProcess = runner([]);

		await expect(
			resolveOllamaWslNetwork('Ubuntu" --exec calc', {
				platform: "win32",
				runProcess,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "invalid_distro",
		});
		expect(runProcess).not.toHaveBeenCalled();
	});

	it("fails closed when Hlid is not running on Windows", async () => {
		const runProcess = runner([]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "linux",
				runProcess,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "unsupported_host",
		});
		expect(runProcess).not.toHaveBeenCalled();
	});

	it("reports unsupported networking modes without probing Windows", async () => {
		const runProcess = runner([{ output: "virtioproxy\n", code: 0 }]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "unsupported_network_mode",
			mode: "virtioproxy",
		});
		expect(runProcess).toHaveBeenCalledOnce();
	});

	it("distinguishes mode, Windows adapter, and route timeouts", async () => {
		const modeTimeout = runner([
			new Error("WSL networking mode probe timed out"),
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: modeTimeout,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "network_mode_probe_timed_out",
		});

		const adapterTimeout = runner([
			{ output: "nat\n", code: 0 },
			new Error("Windows WSL adapter probe timed out"),
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: adapterTimeout,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_adapter_probe_timed_out",
			mode: "nat",
		});

		const routeTimeout = runner([
			{ output: "nat\n", code: 0 },
			{ output: windowsAdapterOutput("172.29.176.1"), code: 0 },
			new Error("WSL default route probe timed out"),
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: routeTimeout,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "default_route_probe_timed_out",
			mode: "nat",
		});
	});

	it("returns UI-safe failures for nonzero probes and missing gateways", async () => {
		const modeFailure = runner([{ output: "localized error", code: 1 }]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: modeFailure,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "network_mode_probe_failed",
		});

		const adapterFailure = runner([
			{ output: "nat", code: 0 },
			{ output: "access denied", code: 1 },
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: adapterFailure,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_adapter_probe_failed",
		});

		const routeFailure = runner([
			{ output: "nat", code: 0 },
			{ output: windowsAdapterOutput("172.29.176.1"), code: 0 },
			{ output: "localized error", code: 1 },
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: routeFailure,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "default_route_probe_failed",
		});

		const missingGateway = runner([
			{ output: "nat", code: 0 },
			{ output: windowsAdapterOutput("172.29.176.1"), code: 0 },
			{ output: "default dev eth0 scope link", code: 0 },
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: missingGateway,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_host_address_unavailable",
		});
	});

	it("requires an exact match between Windows authority and the distro gateway", async () => {
		const mismatch = runner([
			{ output: "nat", code: 0 },
			{ output: windowsAdapterOutput("172.29.176.1"), code: 0 },
			{ output: "default via 172.30.64.1 dev eth0", code: 0 },
		]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: mismatch,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_host_address_mismatch",
			mode: "nat",
		});

		const ambiguous = runner([
			{ output: "nat", code: 0 },
			{
				output:
					windowsAdapterOutput("172.29.176.1") +
					windowsAdapterOutput("172.30.64.1", { interfaceIndex: 43 }),
				code: 0,
			},
			{
				output:
					"default via 172.29.176.1 dev eth0\ndefault via 172.30.64.1 dev eth1",
				code: 0,
			},
		]);
		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess: ambiguous,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_host_address_mismatch",
		});
	});

	it.each([
		[
			"LAN adapter",
			windowsAdapterOutput("192.168.1.1", {
				interfaceAlias: "Ethernet",
				adapterName: "Ethernet",
				interfaceDescription: "Intel Ethernet Adapter",
			}),
			"192.168.1.1",
		],
		[
			"Tailscale adapter",
			windowsAdapterOutput("100.100.100.100", {
				interfaceAlias: "Tailscale",
				adapterName: "Tailscale",
				interfaceDescription: "Tailscale Tunnel",
			}),
			"100.100.100.100",
		],
		["unspecified address", windowsAdapterOutput("0.0.0.0"), "0.0.0.0"],
		[
			"loopback address",
			windowsAdapterOutput("127.0.0.1", { prefixLength: 8 }),
			"127.0.0.1",
		],
		[
			"link-local address",
			windowsAdapterOutput("169.254.10.1", { prefixLength: 16 }),
			"169.254.10.1",
		],
		[
			"multicast address",
			windowsAdapterOutput("224.0.0.1", { prefixLength: 24 }),
			"224.0.0.1",
		],
		[
			"directed broadcast address",
			windowsAdapterOutput("192.168.32.255", { prefixLength: 24 }),
			"192.168.32.255",
		],
		[
			"malformed authority record",
			"HLID_WSL_ADAPTER={bad json}\n",
			"172.29.176.1",
		],
	] as const)("rejects a %s as Windows NAT authority", async (_label, output, gateway) => {
		const runProcess = runner([
			{ output: "nat", code: 0 },
			{ output, code: 0 },
			{ output: `default via ${gateway} dev eth0`, code: 0 },
		]);

		await expect(
			resolveOllamaWslNetwork("Ubuntu", {
				platform: "win32",
				runProcess,
			}),
		).resolves.toMatchObject({
			ready: false,
			reason: "windows_host_address_unavailable",
		});
		expect(runProcess).toHaveBeenCalledTimes(2);
	});
});

describe("WSL NAT IPv4 validation", () => {
	it.each([
		["0.0.0.0", true],
		["127.0.0.1", true],
		["172.29.176.1", true],
		["255.255.255.255", true],
		["172.029.176.1", false],
		["256.1.1.1", false],
		["172.29.176", false],
		["172.29.176.1.example", false],
		["::1", false],
	])("validates canonical dotted-decimal address %s", (address, valid) => {
		expect(isCanonicalIpv4Address(address)).toBe(valid);
	});

	it.each([
		["0.0.0.0", undefined, false],
		["127.0.0.1", 8, false],
		["169.254.10.1", 16, false],
		["100.100.100.100", 10, false],
		["224.0.0.1", 24, false],
		["255.255.255.255", 24, false],
		["192.168.32.0", 24, false],
		["192.168.32.255", 24, false],
		["192.168.32.1", 24, true],
		["172.29.176.1", 20, true],
		["10.255.255.254", 8, true],
	] as const)("validates usable WSL NAT address %s/%s", (address, prefixLength, usable) => {
		expect(isUsableWslNatIpv4Address(address, prefixLength)).toBe(usable);
	});
});
