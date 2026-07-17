import {
	Archive,
	Eye,
	Gem,
	Hammer,
	MessageCircle,
	Scroll,
	Users,
} from "lucide-react";

/**
 * Shared nav item list — rendered by both the desktop Sidebar and the
 * mobile BottomNav. Order is the menu order in both contexts.
 */
export const NAV_ITEMS = [
	{ to: "/", label: "WATCH", icon: Eye, exact: true },
	{ to: "/vault", label: "VAULT", icon: Archive, exact: false },
	{ to: "/relics", label: "RELICS", icon: Gem, exact: false },
	{ to: "/raven", label: "RAVEN", icon: MessageCircle, exact: false },
	{ to: "/einherjar", label: "EINHERJAR", icon: Users, exact: false },
	{ to: "/ledger", label: "LEDGER", icon: Scroll, exact: false },
	{ to: "/forge", label: "FORGE", icon: Hammer, exact: false },
] as const;

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
