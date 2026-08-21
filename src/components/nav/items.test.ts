import { describe, expect, it } from "vitest";
import {
	moreNavItems,
	NAV_ITEMS,
	navActiveOptions,
	navDisplayMetadata,
	navItemsForMode,
	navSearch,
} from "./items";

describe("NAV_ITEMS", () => {
	it("preserves IDs, routes, labels, order, and exact matching behavior", () => {
		expect(
			NAV_ITEMS.map(({ id, to, label, exact }) => ({ id, to, label, exact })),
		).toEqual([
			{ id: "watch", to: "/", label: "WATCH", exact: true },
			{ id: "vault", to: "/vault", label: "VAULT", exact: false },
			{ id: "relics", to: "/relics", label: "RELICS", exact: false },
			{ id: "raven", to: "/raven", label: "RAVEN", exact: false },
			{
				id: "einherjar",
				to: "/einherjar",
				label: "EINHERJAR",
				exact: false,
			},
			{ id: "ledger", to: "/ledger", label: "LEDGER", exact: false },
			{ id: "forge", to: "/forge", label: "FORGE", exact: false },
		]);
	});

	it("keeps the Simple destinations in presentation order", () => {
		expect(
			navItemsForMode("simple").map(({ id, to, label }) => ({ id, to, label })),
		).toEqual([
			{ id: "watch", to: "/", label: "WATCH" },
			{ id: "raven", to: "/raven", label: "RAVEN" },
			{ id: "relics", to: "/relics", label: "RELICS" },
			{ id: "forge", to: "/forge", label: "FORGE" },
		]);
	});

	it("keeps Full unchanged and exposes every omitted destination in More", () => {
		expect(navItemsForMode("full")).toBe(NAV_ITEMS);
		expect(moreNavItems().map(({ to }) => to)).toEqual([
			"/vault",
			"/einherjar",
			"/ledger",
		]);
	});
});

describe("navDisplayMetadata", () => {
	it("adds canonical Hlið context only when a display name is aliased", () => {
		const labels = {
			watch: "HOME",
			vault: "VAULT",
			relics: "RELICS",
			raven: "RAVEN",
			einherjar: "EINHERJAR",
			ledger: "LEDGER",
			forge: "FORGE",
		};
		expect(navDisplayMetadata("watch", "WATCH", labels)).toEqual({
			displayLabel: "HOME",
			ariaLabel: "HOME, Hlið name: WATCH",
			title: "HOME · Hlið: WATCH",
		});
		expect(navDisplayMetadata("vault", "VAULT", labels)).toEqual({
			displayLabel: "VAULT",
			ariaLabel: "VAULT",
			title: undefined,
		});
	});
});

describe("navSearch", () => {
	it("restores the last Raven session only for the Raven destination", () => {
		const lastRavenSession = {
			sessionId: "session-1",
			agent: "/agents/hlid",
		};
		expect(navSearch("/raven", lastRavenSession)).toEqual({
			session: "session-1",
			agent: "/agents/hlid",
		});
		expect(navSearch("/ledger", lastRavenSession)).toBeUndefined();
	});

	it("omits search state when no Raven session has been remembered", () => {
		expect(navSearch("/raven", null)).toBeUndefined();
	});

	it("preserves a Raven session without an agent", () => {
		expect(navSearch("/raven", { sessionId: "session-2" })).toEqual({
			session: "session-2",
			agent: undefined,
		});
	});
});

describe("navActiveOptions", () => {
	it("matches the section pathname without requiring Raven search equality", () => {
		expect(navActiveOptions(false)).toEqual({
			exact: false,
			includeSearch: false,
		});
		expect(navActiveOptions(true)).toEqual({
			exact: true,
			includeSearch: false,
		});
	});
});
