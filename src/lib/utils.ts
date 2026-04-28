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

// Backend API base for browser fetches. Mirrors the WS URL strategy in wsStore:
// Vite dev runs on `appPort`; Bun backend runs on `appPort + 1`. HTTPS deployments
// rely on a same-origin proxy.
export function clampInt(
	raw: string | null,
	def: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number {
	const n = parseInt(raw ?? String(def), 10);
	return Number.isNaN(n) || n < min || n > max ? def : n;
}

export function apiUrl(path: string): string {
	if (typeof window === "undefined") return path;
	const portEnv = (import.meta as { env?: { VITE_WS_PORT?: string } }).env
		?.VITE_WS_PORT;
	if (portEnv) {
		return `${window.location.protocol}//${window.location.hostname}:${portEnv}${path}`;
	}
	if (window.location.protocol === "https:") return path;
	const appPort = Number(window.location.port) || 80;
	return `${window.location.protocol}//${window.location.hostname}:${appPort + 1}${path}`;
}
