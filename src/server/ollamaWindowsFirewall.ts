import { OLLAMA_INFERENCE_RELAY_PORT } from "#/lib/ollama";
import { runBoundedProcess } from "#/lib/process";

export const OLLAMA_WSL_FIREWALL_RULE_NAME = "Hlid-Ollama-WSL";
export const OLLAMA_WSL_VM_CREATOR_ID =
	"{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}";

const FIREWALL_QUERY_TIMEOUT_MS = 5_000;
const FIREWALL_INSTALL_TIMEOUT_MS = 2 * 60_000;

export type OllamaWindowsFirewallStatus = {
	supported: boolean;
	installed: boolean;
	exact: boolean;
	ruleName: string;
	port: number;
	blockedReason?: string;
};

export type OllamaWindowsFirewallOptions = {
	platform?: NodeJS.Platform;
	runProcess?: typeof runBoundedProcess;
};

type FirewallRuleJson = {
	Name?: unknown;
	Direction?: unknown;
	Action?: unknown;
	Protocol?: unknown;
	LocalPorts?: unknown;
	VMCreatorId?: unknown;
	Enabled?: unknown;
};

function encodedPowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function normalizedValues(value: unknown): string[] {
	return (Array.isArray(value) ? value : [value])
		.filter((item): item is string | number =>
			["string", "number"].includes(typeof item),
		)
		.map((item) => String(item).toLowerCase());
}

function hasSingleValue(value: unknown, accepted: readonly string[]): boolean {
	const normalized = normalizedValues(value);
	return normalized.length === 1 && accepted.includes(normalized[0] ?? "");
}

function exactRule(rule: FirewallRuleJson): boolean {
	return (
		String(rule.Name ?? "") === OLLAMA_WSL_FIREWALL_RULE_NAME &&
		hasSingleValue(rule.Direction, ["inbound", "1"]) &&
		hasSingleValue(rule.Action, ["allow", "2"]) &&
		hasSingleValue(rule.Protocol, ["tcp", "6"]) &&
		hasSingleValue(rule.LocalPorts, [String(OLLAMA_INFERENCE_RELAY_PORT)]) &&
		String(rule.VMCreatorId ?? "").toUpperCase() ===
			OLLAMA_WSL_VM_CREATOR_ID.toUpperCase() &&
		hasSingleValue(rule.Enabled, ["true", "1"])
	);
}

function parsedRules(output: string): FirewallRuleJson[] | null {
	let value: unknown;
	try {
		value = JSON.parse(output.trim());
	} catch {
		return null;
	}
	const rules = Array.isArray(value) ? value : [value];
	if (
		rules.length === 0 ||
		rules.some(
			(rule) =>
				typeof rule !== "object" || rule === null || Array.isArray(rule),
		)
	) {
		return null;
	}
	return rules as FirewallRuleJson[];
}

async function runElevatedFirewallScript(
	inner: string,
	options: OllamaWindowsFirewallOptions,
	timeoutError: string,
): Promise<number | null> {
	const innerEncoded = encodedPowerShell(inner);
	const outer = [
		"$ErrorActionPreference = 'Stop'",
		`$child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}') -Wait -PassThru`,
		"exit $child.ExitCode",
	].join("; ");
	const result = await (options.runProcess ?? runBoundedProcess)(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			encodedPowerShell(outer),
		],
		{
			timeoutMs: FIREWALL_INSTALL_TIMEOUT_MS,
			timeoutError,
			maxOutputChars: 8_192,
			shell: false,
		},
	);
	return result.code;
}

export async function getOllamaWindowsFirewallStatus(
	options: OllamaWindowsFirewallOptions = {},
): Promise<OllamaWindowsFirewallStatus> {
	const base = {
		supported: (options.platform ?? process.platform) === "win32",
		installed: false,
		exact: false,
		ruleName: OLLAMA_WSL_FIREWALL_RULE_NAME,
		port: OLLAMA_INFERENCE_RELAY_PORT,
	};
	if (!base.supported) return base;
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$rules = @(Get-NetFirewallHyperVRule -Name '${OLLAMA_WSL_FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue)`,
		"if ($rules.Count -eq 0) { exit 2 }",
		"$selected = @($rules | Select-Object Name,Direction,Action,Protocol,LocalPorts,VMCreatorId,Enabled)",
		"ConvertTo-Json -InputObject $selected -Compress",
	].join("; ");
	try {
		const result = await (options.runProcess ?? runBoundedProcess)(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				encodedPowerShell(script),
			],
			{
				timeoutMs: FIREWALL_QUERY_TIMEOUT_MS,
				timeoutError: "Windows WSL firewall inspection timed out",
				maxOutputChars: 8_192,
				shell: false,
			},
		);
		if (result.code === 2) return base;
		if (result.code !== 0) {
			return {
				...base,
				blockedReason: "Hlid could not inspect the Windows WSL firewall rule.",
			};
		}
		const rules = parsedRules(result.output);
		if (!rules) {
			return {
				...base,
				installed: true,
				blockedReason:
					"Hlid could not verify the Windows WSL firewall rule inventory.",
			};
		}
		const exact = rules.length === 1 && exactRule(rules[0] ?? {});
		return {
			...base,
			installed: true,
			exact,
			...(exact
				? {}
				: {
						blockedReason:
							"The Windows Hyper-V firewall rule inventory for Hlid's Ollama relay is duplicated or broader than inbound TCP 11435 for WSL.",
					}),
		};
	} catch {
		return {
			...base,
			blockedReason: "Hlid could not inspect the Windows WSL firewall rule.",
		};
	}
}

export async function installOllamaWindowsFirewallRule(
	options: OllamaWindowsFirewallOptions = {},
): Promise<OllamaWindowsFirewallStatus> {
	if ((options.platform ?? process.platform) !== "win32") {
		throw new Error(
			"The Ollama WSL firewall rule can be installed only on Windows.",
		);
	}
	const current = await getOllamaWindowsFirewallStatus(options);
	if (current.exact) return current;
	if (current.blockedReason && !current.installed) {
		throw new Error(current.blockedReason);
	}
	if (current.installed) {
		throw new Error(
			current.blockedReason ??
				"The existing Ollama WSL firewall rule conflicts.",
		);
	}
	const inner = [
		"$ErrorActionPreference = 'Stop'",
		`$existing = @(Get-NetFirewallHyperVRule -Name '${OLLAMA_WSL_FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue)`,
		"if ($existing.Count -ne 0) { exit 3 }",
		`New-NetFirewallHyperVRule -Name '${OLLAMA_WSL_FIREWALL_RULE_NAME}' -DisplayName 'Hlid Ollama relay for WSL' -Direction Inbound -Action Allow -Enabled True -VMCreatorId '${OLLAMA_WSL_VM_CREATOR_ID}' -Protocol TCP -LocalPorts '${OLLAMA_INFERENCE_RELAY_PORT}' | Out-Null`,
	].join("; ");
	const exitCode = await runElevatedFirewallScript(
		inner,
		options,
		"Windows approval for the Ollama WSL firewall rule timed out",
	);
	if (exitCode !== 0) {
		throw new Error(
			exitCode === 3
				? "The Ollama WSL firewall rule changed before installation; refresh and retry."
				: "Windows did not install the Ollama WSL firewall rule.",
		);
	}
	const installed = await getOllamaWindowsFirewallStatus(options);
	if (!installed.exact) {
		throw new Error(
			installed.blockedReason ??
				"Windows did not verify the Ollama WSL firewall rule.",
		);
	}
	return installed;
}

export async function removeOllamaWindowsFirewallRule(
	options: OllamaWindowsFirewallOptions = {},
): Promise<OllamaWindowsFirewallStatus> {
	if ((options.platform ?? process.platform) !== "win32") {
		throw new Error(
			"The Ollama WSL firewall rule can be removed only on Windows.",
		);
	}
	const current = await getOllamaWindowsFirewallStatus(options);
	if (!current.installed) {
		if (current.blockedReason) throw new Error(current.blockedReason);
		return current;
	}
	if (!current.exact) {
		throw new Error(
			current.blockedReason ??
				"The existing Ollama WSL firewall rule conflicts.",
		);
	}
	const inner = [
		"$ErrorActionPreference = 'Stop'",
		`$rules = @(Get-NetFirewallHyperVRule -Name '${OLLAMA_WSL_FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue)`,
		"if ($rules.Count -eq 0) { exit 0 }",
		"if ($rules.Count -ne 1) { exit 3 }",
		"$rule = $rules[0]",
		"$direction = @($rule.Direction)",
		"$action = @($rule.Action)",
		"$enabled = @($rule.Enabled)",
		"$protocol = @($rule.Protocol)",
		"$ports = @($rule.LocalPorts)",
		`if ($direction.Count -ne 1 -or @('Inbound','1') -notcontains [string]$direction[0] -or $action.Count -ne 1 -or @('Allow','2') -notcontains [string]$action[0] -or $enabled.Count -ne 1 -or @('True','1') -notcontains [string]$enabled[0] -or $protocol.Count -ne 1 -or @('TCP','6') -notcontains [string]$protocol[0] -or $ports.Count -ne 1 -or [string]$ports[0] -ne '${OLLAMA_INFERENCE_RELAY_PORT}' -or $rule.VMCreatorId -ne '${OLLAMA_WSL_VM_CREATOR_ID}') { exit 3 }`,
		"Remove-NetFirewallHyperVRule -InputObject $rule",
	].join("; ");
	const exitCode = await runElevatedFirewallScript(
		inner,
		options,
		"Windows approval to remove the Ollama WSL firewall rule timed out",
	);
	if (exitCode !== 0) {
		throw new Error(
			exitCode === 3
				? "The Ollama WSL firewall rule changed before removal; refresh and retry."
				: "Windows did not remove the Ollama WSL firewall rule.",
		);
	}
	const removed = await getOllamaWindowsFirewallStatus(options);
	if (removed.installed || removed.blockedReason) {
		throw new Error(
			removed.blockedReason ??
				"Windows did not verify removal of the Ollama WSL firewall rule.",
		);
	}
	return removed;
}
