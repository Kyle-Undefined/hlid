// Allowed: localhost, Tailscale CGNAT, and optionally RFC1918 local network.
export function isAllowedOrigin(
	addr: string | undefined,
	allowLocalNetwork = false,
): boolean {
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
	if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
	if (!allowLocalNetwork) return false;
	// RFC1918: 10.x, 172.16-31.x, 192.168.x
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}
