import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function uid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function clampInt(
	raw: string | null,
	def: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number {
	const n = parseInt(raw ?? String(def), 10);
	return Number.isNaN(n) || n < min || n > max ? def : n;
}
