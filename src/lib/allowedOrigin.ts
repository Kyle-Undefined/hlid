// Allowed: localhost and Tailscale (CGNAT 100.64.0.0/10 + IPv6 fd7a:115c:a1e0::/48).
export function isAllowedOrigin(addr: string | undefined): boolean {
	if (!addr) return false;
	const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
	if (ip === "127.0.0.1" || ip === "::1") return true;
	if (ip.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
	const parts = ip.split(".");
	if (parts.length !== 4) return false;
	if (!parts.every((p) => /^\d+$/.test(p))) return false;
	const octets = parts.map(Number);
	if (octets.some((o) => o < 0 || o > 255)) return false;
	const [a, b] = octets;
	return a === 100 && b >= 64 && b <= 127;
}
