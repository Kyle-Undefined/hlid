import { runBoundedProcess } from "#/lib/process";

export const OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS = 5_000;
export const OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS = 4_096;

const WSL_DISTRO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const NETWORK_MODE_TIMEOUT_ERROR = "WSL networking mode probe timed out";
const WINDOWS_ADAPTER_TIMEOUT_ERROR = "Windows WSL adapter probe timed out";
const DEFAULT_ROUTE_TIMEOUT_ERROR = "WSL default route probe timed out";
const WINDOWS_ADAPTER_RECORD_PREFIX = "HLID_WSL_ADAPTER=";
const WSL_ADAPTER_NAME_PATTERN =
	/^vEthernet \(WSL(?: \(Hyper-V firewall\))?\)$/i;
const HYPER_V_ADAPTER_DESCRIPTION_PATTERN =
	/^Hyper-V Virtual Ethernet Adapter(?: #\d+)?$/i;

export type OllamaWslNetworkMode = "mirrored" | "nat";

export type OllamaWslNetworkFailureReason =
	| "default_route_probe_failed"
	| "default_route_probe_timed_out"
	| "invalid_distro"
	| "network_mode_probe_failed"
	| "network_mode_probe_timed_out"
	| "unsupported_host"
	| "unsupported_network_mode"
	| "windows_adapter_probe_failed"
	| "windows_adapter_probe_timed_out"
	| "windows_host_address_mismatch"
	| "windows_host_address_unavailable";

export type OllamaWslNetworkReadiness =
	| {
			ready: true;
			distro: string;
			mode: OllamaWslNetworkMode;
			windowsHostAddress: string;
			addressSource: "default_ipv4_gateway" | "loopback";
	  }
	| {
			ready: false;
			distro: string;
			reason: OllamaWslNetworkFailureReason;
			blockedReason: string;
			mode?: string;
	  };

export type OllamaWslNetworkDependencies = {
	platform?: NodeJS.Platform;
	runProcess?: typeof runBoundedProcess;
};

function blocked(
	distro: string,
	reason: OllamaWslNetworkFailureReason,
	blockedReason: string,
	mode?: string,
): OllamaWslNetworkReadiness {
	return {
		ready: false,
		distro,
		reason,
		blockedReason,
		...(mode ? { mode } : {}),
	};
}

function cleanOutput(value: string): string {
	return value
		.replaceAll("\0", "")
		.replace(/^\uFEFF/, "")
		.trim();
}

function reportedNetworkMode(output: string): string | null {
	const lines = cleanOutput(output)
		.split(/\r?\n/)
		.map((line) => line.trim().toLowerCase())
		.filter(Boolean);
	const known = lines.find((line) =>
		["bridged", "mirrored", "nat", "none", "virtioproxy"].includes(line),
	);
	return known ?? null;
}

/** Accept only canonical dotted-decimal IPv4 addresses. */
export function isCanonicalIpv4Address(value: string): boolean {
	const octets = value.split(".");
	if (octets.length !== 4) return false;
	return octets.every((octet) => {
		if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false;
		const parsed = Number(octet);
		return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
	});
}

function ipv4Octets(value: string): number[] | null {
	if (!isCanonicalIpv4Address(value)) return null;
	return value.split(".").map(Number);
}

/**
 * Restrict a NAT bind address to a usable RFC1918 host address. Adapter
 * provenance is checked separately against Windows-owned WSL Hyper-V state.
 */
export function isUsableWslNatIpv4Address(
	value: string,
	prefixLength?: number,
): boolean {
	const octets = ipv4Octets(value);
	if (!octets) return false;
	const [first = 0, second = 0] = octets;
	const privateAddress =
		first === 10 ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168);
	if (!privateAddress) return false;
	if (prefixLength === undefined) return true;
	if (
		!Number.isSafeInteger(prefixLength) ||
		prefixLength < 1 ||
		prefixLength > 30
	) {
		return false;
	}
	const address = octets.reduce(
		(result, octet) => ((result << 8) | octet) >>> 0,
		0,
	);
	const hostMask = 2 ** (32 - prefixLength) - 1;
	const host = address & hostMask;
	return host !== 0 && host !== hostMask;
}

type WindowsWslAdapterAddress = {
	address: string;
	prefixLength: number;
	interfaceAlias: string;
	adapterName: string;
	interfaceDescription: string;
	interfaceIndex: number;
	status: string;
};

function encodedPowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function windowsWslAdapterScript(): string {
	return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$adapters = @(Get-NetAdapter -Name '*' -IncludeHidden -ErrorAction Stop | Where-Object {
	$_.Name -match '^vEthernet \(WSL(?: \(Hyper-V firewall\))?\)$' -and
	$_.InterfaceDescription -match '^Hyper-V Virtual Ethernet Adapter(?: #\d+)?$' -and
	$_.Status -eq 'Up'
})
$records = @()
foreach ($adapter in $adapters) {
	$addresses = @(Get-NetIPAddress -InterfaceIndex $adapter.InterfaceIndex -AddressFamily IPv4 -Type Unicast -AddressState Preferred -ErrorAction Stop)
	foreach ($address in $addresses) {
		$records += [pscustomobject]@{
			address = [string]$address.IPAddress
			prefixLength = [int]$address.PrefixLength
			interfaceAlias = [string]$address.InterfaceAlias
			adapterName = [string]$adapter.Name
			interfaceDescription = [string]$adapter.InterfaceDescription
			interfaceIndex = [int]$adapter.InterfaceIndex
			status = [string]$adapter.Status
		}
	}
}
if ($records.Count -gt 8) { exit 3 }
foreach ($record in $records) {
	Write-Output ('${WINDOWS_ADAPTER_RECORD_PREFIX}' + ($record | ConvertTo-Json -Compress))
}
`.trim();
}

function parsedWindowsWslAdapterAddress(
	value: unknown,
): WindowsWslAdapterAddress | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.address !== "string" ||
		typeof record.prefixLength !== "number" ||
		typeof record.interfaceAlias !== "string" ||
		typeof record.adapterName !== "string" ||
		typeof record.interfaceDescription !== "string" ||
		typeof record.interfaceIndex !== "number" ||
		typeof record.status !== "string"
	) {
		return null;
	}
	const address = {
		address: record.address,
		prefixLength: record.prefixLength,
		interfaceAlias: record.interfaceAlias,
		adapterName: record.adapterName,
		interfaceDescription: record.interfaceDescription,
		interfaceIndex: record.interfaceIndex,
		status: record.status,
	};
	if (
		!isUsableWslNatIpv4Address(address.address, address.prefixLength) ||
		!WSL_ADAPTER_NAME_PATTERN.test(address.interfaceAlias) ||
		address.interfaceAlias.toLowerCase() !==
			address.adapterName.toLowerCase() ||
		!WSL_ADAPTER_NAME_PATTERN.test(address.adapterName) ||
		!HYPER_V_ADAPTER_DESCRIPTION_PATTERN.test(address.interfaceDescription) ||
		!Number.isSafeInteger(address.interfaceIndex) ||
		address.interfaceIndex <= 0 ||
		address.status.toLowerCase() !== "up"
	) {
		return null;
	}
	return address;
}

function windowsWslAdapterAddresses(output: string): Set<string> | null {
	const addresses = new Set<string>();
	for (const line of cleanOutput(output).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (!trimmed.startsWith(WINDOWS_ADAPTER_RECORD_PREFIX)) return null;
		let value: unknown;
		try {
			value = JSON.parse(trimmed.slice(WINDOWS_ADAPTER_RECORD_PREFIX.length));
		} catch {
			return null;
		}
		const parsed = parsedWindowsWslAdapterAddress(value);
		if (!parsed) return null;
		addresses.add(parsed.address);
	}
	return addresses;
}

function parseWslDefaultIpv4Gateways(output: string): string[] {
	const gateways = new Set<string>();
	for (const line of cleanOutput(output).split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields[0]?.toLowerCase() !== "default") continue;
		for (let index = 1; index < fields.length - 1; index++) {
			if (fields[index]?.toLowerCase() !== "via") continue;
			const candidate = fields[index + 1];
			if (candidate && isUsableWslNatIpv4Address(candidate)) {
				gateways.add(candidate);
			}
		}
	}
	return [...gateways];
}

function timedOut(error: unknown, timeoutError: string): boolean {
	return error instanceof Error && error.message === timeoutError;
}

/**
 * Resolve how one exact WSL distro can reach a Windows-owned Ollama relay.
 *
 * The distro is always passed as its own wsl.exe argument. No caller-controlled
 * value is interpolated into a shell command.
 */
export async function resolveOllamaWslNetwork(
	distro: string,
	dependencies: OllamaWslNetworkDependencies = {},
): Promise<OllamaWslNetworkReadiness> {
	if ((dependencies.platform ?? process.platform) !== "win32") {
		return blocked(
			distro,
			"unsupported_host",
			"The Ollama WSL relay requires Hlid to run on Windows.",
		);
	}
	if (
		distro.length === 0 ||
		distro.length > 128 ||
		distro !== distro.trim() ||
		!WSL_DISTRO_NAME_PATTERN.test(distro)
	) {
		return blocked(
			distro,
			"invalid_distro",
			"The configured WSL distro name is invalid.",
		);
	}

	const runProcess = dependencies.runProcess ?? runBoundedProcess;
	let modeResult: Awaited<ReturnType<typeof runBoundedProcess>>;
	try {
		modeResult = await runProcess(
			"wsl.exe",
			["-d", distro, "--exec", "/usr/bin/wslinfo", "--networking-mode"],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: NETWORK_MODE_TIMEOUT_ERROR,
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
	} catch (error) {
		return timedOut(error, NETWORK_MODE_TIMEOUT_ERROR)
			? blocked(
					distro,
					"network_mode_probe_timed_out",
					"The WSL distro did not report its networking mode before the probe timed out.",
				)
			: blocked(
					distro,
					"network_mode_probe_failed",
					"Hlid could not query the WSL distro's networking mode.",
				);
	}

	if (modeResult.code !== 0) {
		return blocked(
			distro,
			"network_mode_probe_failed",
			"The WSL distro could not report its networking mode. Update WSL and retry.",
		);
	}
	const mode = reportedNetworkMode(modeResult.output);
	if (mode === "mirrored") {
		return {
			ready: true,
			distro,
			mode,
			windowsHostAddress: "127.0.0.1",
			addressSource: "loopback",
		};
	}
	if (mode !== "nat") {
		return blocked(
			distro,
			"unsupported_network_mode",
			mode
				? `WSL networking mode ${mode} is not supported by the Ollama relay. Use NAT or mirrored networking.`
				: "The WSL distro reported an unrecognized networking mode. Use NAT or mirrored networking.",
			mode ?? undefined,
		);
	}

	let windowsAdapterResult: Awaited<ReturnType<typeof runBoundedProcess>>;
	try {
		windowsAdapterResult = await runProcess(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				encodedPowerShell(windowsWslAdapterScript()),
			],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: WINDOWS_ADAPTER_TIMEOUT_ERROR,
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
	} catch (error) {
		return timedOut(error, WINDOWS_ADAPTER_TIMEOUT_ERROR)
			? blocked(
					distro,
					"windows_adapter_probe_timed_out",
					"Windows did not report its WSL Hyper-V adapter before the probe timed out.",
					mode,
				)
			: blocked(
					distro,
					"windows_adapter_probe_failed",
					"Hlid could not inspect the Windows WSL Hyper-V adapter.",
					mode,
				);
	}
	if (windowsAdapterResult.code !== 0) {
		return blocked(
			distro,
			"windows_adapter_probe_failed",
			"Windows could not report its WSL Hyper-V adapter.",
			mode,
		);
	}
	const windowsAddresses = windowsWslAdapterAddresses(
		windowsAdapterResult.output,
	);
	if (!windowsAddresses || windowsAddresses.size === 0) {
		return blocked(
			distro,
			"windows_host_address_unavailable",
			"Windows did not report a preferred private IPv4 address on an active WSL Hyper-V adapter.",
			mode,
		);
	}

	let routeResult: Awaited<ReturnType<typeof runBoundedProcess>>;
	try {
		routeResult = await runProcess(
			"wsl.exe",
			[
				"-d",
				distro,
				"--exec",
				"/usr/sbin/ip",
				"-4",
				"route",
				"show",
				"default",
			],
			{
				timeoutMs: OLLAMA_WSL_NETWORK_PROBE_TIMEOUT_MS,
				timeoutError: DEFAULT_ROUTE_TIMEOUT_ERROR,
				maxOutputChars: OLLAMA_WSL_NETWORK_MAX_OUTPUT_CHARS,
				shell: false,
			},
		);
	} catch (error) {
		return timedOut(error, DEFAULT_ROUTE_TIMEOUT_ERROR)
			? blocked(
					distro,
					"default_route_probe_timed_out",
					"The WSL distro did not report its default IPv4 route before the probe timed out.",
					mode,
				)
			: blocked(
					distro,
					"default_route_probe_failed",
					"Hlid could not query the WSL distro's default IPv4 route.",
					mode,
				);
	}

	if (routeResult.code !== 0) {
		return blocked(
			distro,
			"default_route_probe_failed",
			"The WSL distro could not report its default IPv4 route.",
			mode,
		);
	}
	const routeGateways = parseWslDefaultIpv4Gateways(routeResult.output);
	if (routeGateways.length === 0) {
		return blocked(
			distro,
			"windows_host_address_unavailable",
			"The WSL NAT route did not contain a valid Windows host IPv4 gateway.",
			mode,
		);
	}
	const corroborated = routeGateways.filter((address) =>
		windowsAddresses.has(address),
	);
	if (corroborated.length !== 1) {
		return blocked(
			distro,
			"windows_host_address_mismatch",
			"The WSL NAT gateway did not exactly match one Windows-owned WSL Hyper-V adapter address.",
			mode,
		);
	}
	const [windowsHostAddress] = corroborated;
	if (!windowsHostAddress) {
		return blocked(
			distro,
			"windows_host_address_mismatch",
			"The WSL NAT gateway did not exactly match one Windows-owned WSL Hyper-V adapter address.",
			mode,
		);
	}

	return {
		ready: true,
		distro,
		mode,
		windowsHostAddress,
		addressSource: "default_ipv4_gateway",
	};
}
