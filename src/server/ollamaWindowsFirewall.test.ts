import { describe, expect, it, vi } from "vitest";
import type { runBoundedProcess } from "#/lib/process";
import {
	getOllamaWindowsFirewallStatus,
	installOllamaWindowsFirewallRule,
	OLLAMA_WSL_FIREWALL_RULE_NAME,
	OLLAMA_WSL_VM_CREATOR_ID,
	removeOllamaWindowsFirewallRule,
} from "./ollamaWindowsFirewall";

const exactRule = {
	Name: OLLAMA_WSL_FIREWALL_RULE_NAME,
	Direction: 1,
	Action: 2,
	Protocol: "TCP",
	LocalPorts: ["11435"],
	VMCreatorId: OLLAMA_WSL_VM_CREATOR_ID,
	Enabled: 1,
};

function rulesOutput(...rules: Array<Record<string, unknown>>): string {
	return JSON.stringify(rules);
}

function runner(
	results: Array<{ output: string; code: number | null } | Error>,
) {
	return vi.fn(async (..._args: Parameters<typeof runBoundedProcess>) => {
		const result = results.shift();
		if (result instanceof Error) throw result;
		return result ?? { output: "", code: 0 };
	});
}

function decodedElevatedScript(
	runProcess: ReturnType<typeof runner>,
	callIndex: number,
): string {
	const elevatedArgs = runProcess.mock.calls[callIndex]?.[1];
	const outer = Buffer.from(elevatedArgs?.[3] ?? "", "base64").toString(
		"utf16le",
	);
	const innerEncoded = outer.match(/'-EncodedCommand','([^']+)'/)?.[1];
	return Buffer.from(innerEncoded ?? "", "base64").toString("utf16le");
}

describe("Ollama WSL Windows firewall", () => {
	it("reports exactly one WSL-only inbound TCP 11435 rule", async () => {
		const runProcess = runner([{ output: rulesOutput(exactRule), code: 0 }]);

		await expect(
			getOllamaWindowsFirewallStatus({ platform: "win32", runProcess }),
		).resolves.toMatchObject({
			supported: true,
			installed: true,
			exact: true,
			port: 11435,
		});
		const encoded = runProcess.mock.calls[0]?.[1]?.[3] ?? "";
		const script = Buffer.from(encoded, "base64").toString("utf16le");
		expect(script).toContain("$rules = @(");
		expect(script).toContain("ConvertTo-Json -InputObject $selected");
		expect(script).not.toContain("Select-Object -First 1");
	});

	it.each([
		["multiple local ports", [{ ...exactRule, LocalPorts: ["11435", "443"] }]],
		["multiple protocols", [{ ...exactRule, Protocol: ["TCP", "UDP"] }]],
		["a second same-name rule", [exactRule, { ...exactRule }]],
		["an Any local-port rule", [{ ...exactRule, LocalPorts: ["Any"] }]],
	] as const)("does not accept %s", async (_label, rules) => {
		const runProcess = runner([{ output: rulesOutput(...rules), code: 0 }]);

		await expect(
			getOllamaWindowsFirewallStatus({ platform: "win32", runProcess }),
		).resolves.toMatchObject({
			installed: true,
			exact: false,
			blockedReason: expect.stringContaining("duplicated or broader"),
		});
	});

	it("fails closed when the same-name rule inventory is malformed", async () => {
		const runProcess = runner([{ output: "truncated-json", code: 0 }]);

		await expect(
			getOllamaWindowsFirewallStatus({ platform: "win32", runProcess }),
		).resolves.toMatchObject({
			installed: true,
			exact: false,
			blockedReason: expect.stringContaining("could not verify"),
		});
	});

	it("requests elevation only after confirming every same-name rule is absent", async () => {
		const runProcess = runner([
			{ output: "", code: 2 },
			{ output: "", code: 0 },
			{ output: rulesOutput(exactRule), code: 0 },
		]);

		await expect(
			installOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
		).resolves.toMatchObject({ exact: true });
		expect(runProcess).toHaveBeenCalledTimes(3);
		const elevatedArgs = runProcess.mock.calls[1]?.[1];
		expect(elevatedArgs?.slice(0, 3)).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		]);
		const inner = decodedElevatedScript(runProcess, 1);
		expect(inner).toContain(`-Name '${OLLAMA_WSL_FIREWALL_RULE_NAME}'`);
		expect(inner).toContain(`$existing = @(`);
		expect(inner).toContain("$existing.Count -ne 0");
		expect(inner).toContain(`-VMCreatorId '${OLLAMA_WSL_VM_CREATOR_ID}'`);
		expect(inner).toContain("-Protocol TCP -LocalPorts '11435'");
		expect(inner).not.toContain("DefaultInboundAction");
	});

	it("never elevates over duplicate same-name rules", async () => {
		const runProcess = runner([
			{ output: rulesOutput(exactRule, exactRule), code: 0 },
		]);

		await expect(
			installOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
		).rejects.toThrow("duplicated or broader");
		expect(runProcess).toHaveBeenCalledOnce();
	});

	it("never invokes PowerShell from a non-Windows host", async () => {
		const runProcess = runner([]);
		await expect(
			getOllamaWindowsFirewallStatus({ platform: "linux", runProcess }),
		).resolves.toMatchObject({ supported: false, installed: false });
		expect(runProcess).not.toHaveBeenCalled();
	});

	it("removes only one revalidated exact Hlid-owned rule after elevation", async () => {
		const runProcess = runner([
			{ output: rulesOutput(exactRule), code: 0 },
			{ output: "", code: 0 },
			{ output: "", code: 2 },
		]);

		await expect(
			removeOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
		).resolves.toMatchObject({ installed: false, exact: false });
		const inner = decodedElevatedScript(runProcess, 1);
		expect(inner).toContain("$rules.Count -ne 1");
		expect(inner).toContain("$protocol.Count -ne 1");
		expect(inner).toContain("$ports.Count -ne 1");
		expect(inner).toContain("Remove-NetFirewallHyperVRule -InputObject $rule");
		expect(inner).toContain("$rule.VMCreatorId");
		expect(inner).not.toContain("-All");
	});

	it("does not remove duplicate or broader same-name rules", async () => {
		for (const rules of [
			[exactRule, exactRule],
			[{ ...exactRule, LocalPorts: ["11435", "443"] }],
		]) {
			const runProcess = runner([{ output: rulesOutput(...rules), code: 0 }]);
			await expect(
				removeOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
			).rejects.toThrow("duplicated or broader");
			expect(runProcess).toHaveBeenCalledOnce();
		}
	});

	it("does not treat a failed pre-removal inspection as verified absence", async () => {
		const runProcess = runner([{ output: "inspection failed", code: 1 }]);

		await expect(
			removeOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
		).rejects.toThrow("could not inspect");
		expect(runProcess).toHaveBeenCalledOnce();
	});

	it("does not treat a failed post-removal inspection as verified absence", async () => {
		const runProcess = runner([
			{ output: rulesOutput(exactRule), code: 0 },
			{ output: "", code: 0 },
			{ output: "inspection failed", code: 1 },
		]);

		await expect(
			removeOllamaWindowsFirewallRule({ platform: "win32", runProcess }),
		).rejects.toThrow("could not inspect");
		expect(runProcess).toHaveBeenCalledTimes(3);
	});
});
