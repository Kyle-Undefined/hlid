import type { HlidConfig } from "#/config";

export type ObsidianCaptureDestination = {
	kind: "inbox" | "raw";
	label: "Inbox" | "Raw";
	folder: string;
	vaultName: string;
	template: string | null;
};

function normalizedCaptureFolder(value: string | undefined): string | null {
	const folder = value
		?.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/g, "");
	return folder || null;
}

export function configuredObsidianCapture(
	vault: HlidConfig["vault"],
): ObsidianCaptureDestination | null {
	const inbox = normalizedCaptureFolder(vault.inbox);
	const raw = normalizedCaptureFolder(vault.raw);
	const selected =
		vault.style === "wiki"
			? raw && { kind: "raw" as const, label: "Raw" as const, folder: raw }
			: vault.style === "para"
				? inbox && {
						kind: "inbox" as const,
						label: "Inbox" as const,
						folder: inbox,
					}
				: inbox
					? {
							kind: "inbox" as const,
							label: "Inbox" as const,
							folder: inbox,
						}
					: raw && { kind: "raw" as const, label: "Raw" as const, folder: raw };
	if (!selected) return null;
	return {
		...selected,
		vaultName: vault.name,
		template: vault.save_to_obsidian_template?.trim() || null,
	};
}

function padded(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

export function obsidianCaptureTimestamp(date: Date): string {
	return [
		`${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())}`,
		`${padded(date.getHours())}-${padded(date.getMinutes())}-${padded(date.getSeconds())}-${padded(date.getMilliseconds(), 3)}`,
	].join(" ");
}

export function obsidianCaptureNotePath(
	destination: ObsidianCaptureDestination,
	date: Date,
	nonce: string,
): string {
	const safeNonce = nonce.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "capture";
	return `${destination.folder}/Hlid ${obsidianCaptureTimestamp(date)} ${safeNonce}.md`;
}
