// Detect Tailscale install + auth state via the local CLI.
// Used by /api/tailscale to drive the setup widget in forge.

import { runCapturedProcess } from "./process";

const WIN_FALLBACK = "C:\\Program Files\\Tailscale\\tailscale.exe";

type TailscaleStatusRaw = {
	BackendState?: string;
	Self?: {
		DNSName?: string;
		TailscaleIPs?: string[];
	};
	MagicDNSSuffix?: string;
};

export type TailscaleState =
	| "Running"
	| "NeedsLogin"
	| "Stopped"
	| "Starting"
	| "NoState"
	| "Unknown";

const TAILSCALE_STATES: ReadonlySet<TailscaleState> = new Set([
	"Running",
	"NeedsLogin",
	"Stopped",
	"Starting",
	"NoState",
	"Unknown",
]);

function coerceTailscaleState(value: string | undefined): TailscaleState {
	if (value && (TAILSCALE_STATES as ReadonlySet<string>).has(value)) {
		return value as TailscaleState;
	}
	return "Unknown";
}

export type TailscaleStatus = {
	installed: boolean;
	state: TailscaleState | null;
	magicDNS: string | null;
	ips: string[];
	error?: string;
};

async function runTailscale(
	binary: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number } | null> {
	try {
		return await runCapturedProcess([binary, ...args]);
	} catch {
		return null;
	}
}

async function statusJson(): Promise<{
	binary: string;
	result: { stdout: string; stderr: string; code: number };
} | null> {
	const candidates = ["tailscale"];
	if (process.platform === "win32") candidates.push(WIN_FALLBACK);
	for (const bin of candidates) {
		const r = await runTailscale(bin, ["status", "--json"]);
		if (r) return { binary: bin, result: r };
	}
	return null;
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
	const probe = await statusJson();
	if (!probe) {
		return { installed: false, state: null, magicDNS: null, ips: [] };
	}
	const { stdout, stderr, code } = probe.result;
	// `tailscale status --json` exits non-zero when not logged in but still
	// emits valid JSON describing the state. Try to parse before bailing.
	let parsed: TailscaleStatusRaw | null = null;
	try {
		parsed = JSON.parse(stdout) as TailscaleStatusRaw;
	} catch {
		parsed = null;
	}
	if (!parsed) {
		return {
			installed: true,
			state: null,
			magicDNS: null,
			ips: [],
			error: stderr.trim() || `tailscale exited ${code}`,
		};
	}
	const dns = parsed.Self?.DNSName?.replace(/\.$/, "") ?? null;
	return {
		installed: true,
		state: coerceTailscaleState(parsed.BackendState),
		magicDNS: dns,
		ips: parsed.Self?.TailscaleIPs ?? [],
	};
}
