import {
	Archive,
	Eye,
	Gem,
	Hammer,
	MessageCircle,
	Scroll,
	Users,
} from "lucide-react";
import type { NavigationId } from "#/lib/navigationNames";

/**
 * Shared nav item list — rendered by both the desktop Sidebar and the
 * mobile BottomNav. Order is the menu order in both contexts.
 */
export const NAV_ITEMS = [
	{ id: "watch", to: "/", label: "WATCH", icon: Eye, exact: true },
	{
		id: "vault",
		to: "/vault",
		label: "VAULT",
		icon: Archive,
		exact: false,
	},
	{ id: "relics", to: "/relics", label: "RELICS", icon: Gem, exact: false },
	{
		id: "raven",
		to: "/raven",
		label: "RAVEN",
		icon: MessageCircle,
		exact: false,
	},
	{
		id: "einherjar",
		to: "/einherjar",
		label: "EINHERJAR",
		icon: Users,
		exact: false,
	},
	{
		id: "ledger",
		to: "/ledger",
		label: "LEDGER",
		icon: Scroll,
		exact: false,
	},
	{ id: "forge", to: "/forge", label: "FORGE", icon: Hammer, exact: false },
] as const;

export const SIMPLE_NAV_IDS = ["watch", "raven", "relics", "forge"] as const;

export function navItemsForMode(mode: "full" | "simple") {
	if (mode === "full") return NAV_ITEMS;
	return SIMPLE_NAV_IDS.map((id) => {
		const item = NAV_ITEMS.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Unknown Simple navigation item: ${id}`);
		return item;
	});
}

export function moreNavItems() {
	return NAV_ITEMS.filter(
		(item) =>
			!SIMPLE_NAV_IDS.includes(item.id as (typeof SIMPLE_NAV_IDS)[number]),
	);
}

export function navDisplayMetadata(
	id: NavigationId,
	canonicalLabel: string,
	navigationLabels: Record<NavigationId, string>,
) {
	const displayLabel = navigationLabels[id] ?? canonicalLabel;
	const aliased = displayLabel !== canonicalLabel;
	return {
		displayLabel,
		ariaLabel: aliased
			? `${displayLabel}, Hlið name: ${canonicalLabel}`
			: displayLabel,
		title: aliased ? `${displayLabel} · Hlið: ${canonicalLabel}` : undefined,
	};
}

export function navSearch(
	to: (typeof NAV_ITEMS)[number]["to"],
	lastRavenSession: { sessionId: string; agent?: string } | null,
): { session: string; agent?: string } | undefined {
	if (to !== "/raven" || !lastRavenSession) return undefined;
	return {
		session: lastRavenSession.sessionId,
		agent: lastRavenSession.agent,
	};
}

/** Section highlighting follows the pathname; search only chooses the Raven chat. */
export function navActiveOptions(exact: boolean) {
	return { exact, includeSearch: false } as const;
}
