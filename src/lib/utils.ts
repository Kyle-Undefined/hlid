export function uid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Escape a string for literal use inside a RegExp pattern. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Max chars for an auto-generated session label (server + client must agree). */
export const SESSION_LABEL_LENGTH = 40;

export function clampInt(
	raw: string | null,
	def: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number {
	const n = parseInt(raw ?? String(def), 10);
	return Number.isNaN(n) || n < min || n > max ? def : n;
}
