// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsageSnapshot } from "#/db";
import { builtInProviderUsageShells } from "#/lib/usageWindows";
import { ProviderUsageStrip } from "./ProviderUsageStrip";

const initial: ProviderUsageSnapshot[] = [
	{
		providerId: "claude",
		providerLabel: "Claude",
		windows: [],
	},
];

function setVisibility(state: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: state,
	});
}

function renderStrip(fetchFn = vi.fn().mockResolvedValue(initial)) {
	render(
		<ProviderUsageStrip
			initial={initial}
			liveQueryCount={0}
			rateLimit={null}
			fetchFn={fetchFn}
		/>,
	);
	return fetchFn;
}

beforeEach(() => {
	vi.useFakeTimers();
	setVisibility("visible");
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("ProviderUsageStrip polling", () => {
	it("keeps the provider window shell mounted while Cockpit hydrates", () => {
		const fetchFn = vi.fn(() => new Promise<ProviderUsageSnapshot[]>(() => {}));
		render(
			<ProviderUsageStrip
				initial={builtInProviderUsageShells()}
				initialStale
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		expect(screen.getByText("5-HOUR")).not.toBeNull();
		expect(screen.getByText("7-DAY")).not.toBeNull();
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("restores last-known usage into the stable shell before a refresh resolves", async () => {
		const cached = [
			{
				providerId: "codex",
				providerLabel: "Codex",
				windows: [
					{
						...builtInProviderUsageShells()[1].windows[0],
						queries: 7,
						cost: 4.25,
					},
				],
			},
		] satisfies ProviderUsageSnapshot[];
		sessionStorage.setItem(
			"hlid_provider_usage_snapshots",
			JSON.stringify(cached),
		);
		localStorage.setItem("hlid_active_provider", "codex");

		render(
			<ProviderUsageStrip
				initial={builtInProviderUsageShells()}
				initialStale
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn(() => new Promise<ProviderUsageSnapshot[]>(() => {}))}
			/>,
		);
		await act(async () => {});

		expect(screen.getByText("7 queries")).not.toBeNull();
		expect(screen.getByText("~$4.25")).not.toBeNull();
	});

	it("does not let a route-invalidated layout shell clear fresh usage", async () => {
		const fresh = builtInProviderUsageShells().map((snapshot) => ({
			...snapshot,
			windows: snapshot.windows.map((window) => ({
				...window,
				queries: 9,
				cost: 6.5,
			})),
		}));
		const view = render(
			<ProviderUsageStrip
				initial={builtInProviderUsageShells()}
				initialStale
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn().mockResolvedValue(fresh)}
			/>,
		);
		await act(async () => {});
		expect(screen.getAllByText("9 queries").length).toBeGreaterThan(0);

		view.rerender(
			<ProviderUsageStrip
				initial={builtInProviderUsageShells()}
				initialStale
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn().mockResolvedValue(fresh)}
			/>,
		);

		expect(screen.getAllByText("9 queries").length).toBeGreaterThan(0);
		expect(screen.queryByText("0 queries")).toBeNull();
	});

	it("shows provider data that arrives after immediate ledger hydration", async () => {
		const loaded: ProviderUsageSnapshot[] = [
			{
				providerId: "codex",
				providerLabel: "Codex",
				windows: [
					{
						windowId: "five_hour",
						label: "CODEX 5-HOUR",
						windowSecs: 18_000,
						utilization: 0.25,
						remaining: null,
						limit: null,
						resetsAt: null,
						cost: 3,
						queries: 2,
						tokens: 100,
						sessions: 1,
					},
				],
			},
		];
		const fetchFn = vi.fn().mockResolvedValue(loaded);
		render(
			<ProviderUsageStrip
				initial={[]}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		expect(screen.queryByText("CODEX 5-HOUR")).toBeNull();
		await act(async () => {});

		expect(fetchFn).toHaveBeenCalledOnce();
		expect(screen.getByText("CODEX 5-HOUR")).not.toBeNull();
	});

	it("restores a stored provider after the hydration-stable first render", async () => {
		const providers: ProviderUsageSnapshot[] = [
			{ providerId: "claude", providerLabel: "Claude", windows: [] },
			{ providerId: "codex", providerLabel: "Codex", windows: [] },
		];
		localStorage.setItem("hlid_active_provider", "codex");

		render(
			<ProviderUsageStrip
				initial={providers}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn().mockResolvedValue(providers)}
			/>,
		);

		await act(async () => {});
		expect(screen.getByRole("button", { name: "Codex" }).className).toContain(
			"text-foreground/70",
		);
	});
	it("keeps the chat provider visible when another provider reports usage", () => {
		const providers: ProviderUsageSnapshot[] = [
			{
				providerId: "claude",
				providerLabel: "Claude",
				windows: [
					{
						windowId: "five_hour",
						label: "CLAUDE 5-HOUR",
						windowSecs: 18_000,
						utilization: 0.94,
						remaining: null,
						limit: null,
						resetsAt: null,
						cost: 1,
						queries: 1,
						tokens: 100,
						sessions: 1,
					},
				],
			},
			{
				providerId: "codex",
				providerLabel: "Codex",
				windows: [
					{
						windowId: "five_hour",
						label: "CODEX 5-HOUR",
						windowSecs: 18_000,
						utilization: 0.52,
						remaining: null,
						limit: null,
						resetsAt: null,
						cost: 2,
						queries: 2,
						tokens: 200,
						sessions: 1,
					},
				],
			},
		];
		const fetchFn = vi.fn(() => new Promise<ProviderUsageSnapshot[]>(() => {}));
		const view = render(
			<ProviderUsageStrip
				initial={providers}
				liveQueryCount={0}
				rateLimit={null}
				preferredProviderId="codex"
				fetchFn={fetchFn}
			/>,
		);

		expect(screen.getByText("CODEX 5-HOUR")).not.toBeNull();
		expect(screen.queryByText("CLAUDE 5-HOUR")).toBeNull();

		view.rerender(
			<ProviderUsageStrip
				initial={providers}
				liveQueryCount={0}
				rateLimit={{
					type: "rate_limit",
					status: "allowed",
					providerId: "claude",
					rateLimitType: "five_hour",
					utilization: 0.98,
				}}
				preferredProviderId="codex"
				fetchFn={fetchFn}
			/>,
		);

		expect(screen.getByText("CODEX 5-HOUR")).not.toBeNull();
		expect(screen.queryByText("CLAUDE 5-HOUR")).toBeNull();
	});

	it("follows the provider selected for the current chat", () => {
		const providers: ProviderUsageSnapshot[] = [
			{ providerId: "claude", providerLabel: "Claude", windows: [] },
			{ providerId: "codex", providerLabel: "Codex", windows: [] },
		];
		const view = render(
			<ProviderUsageStrip
				initial={providers}
				liveQueryCount={0}
				rateLimit={null}
				preferredProviderId="codex"
				fetchFn={vi.fn().mockResolvedValue(providers)}
			/>,
		);

		expect(screen.getByRole("button", { name: "Codex" }).className).toContain(
			"text-foreground/70",
		);

		view.rerender(
			<ProviderUsageStrip
				initial={providers}
				liveQueryCount={0}
				rateLimit={null}
				preferredProviderId="claude"
				fetchFn={vi.fn().mockResolvedValue(providers)}
			/>,
		);

		expect(screen.getByRole("button", { name: "Claude" }).className).toContain(
			"text-foreground/70",
		);
	});

	it("marks Claude SDK cost as estimated", () => {
		const claudeWithUsage: ProviderUsageSnapshot[] = [
			{
				providerId: "claude",
				providerLabel: "Claude",
				windows: [
					{
						windowId: "five-hour",
						label: "5 HOUR",
						windowSecs: 18_000,
						utilization: 0.25,
						remaining: null,
						limit: null,
						resetsAt: null,
						cost: 7.6,
						queries: 4,
						tokens: 100,
						sessions: 1,
					},
				],
			},
		];
		render(
			<ProviderUsageStrip
				initial={claudeWithUsage}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={vi.fn().mockResolvedValue(claudeWithUsage)}
			/>,
		);

		expect(screen.getByText("~$7.60")).not.toBeNull();
	});

	it("refreshes authoritative totals when a live window reading arrives", () => {
		const fetchFn = vi.fn().mockResolvedValue(initial);
		const view = render(
			<ProviderUsageStrip
				initial={initial}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		view.rerender(
			<ProviderUsageStrip
				initial={initial}
				liveQueryCount={0}
				rateLimit={{
					type: "rate_limit",
					status: "allowed",
					providerId: "claude",
					rateLimitType: "five_hour",
					utilization: 0.2,
				}}
				fetchFn={fetchFn}
			/>,
		);

		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("ignores an older refresh that resolves after the post-done totals", async () => {
		const stale = Promise.withResolvers<ProviderUsageSnapshot[]>();
		const fresh = Promise.withResolvers<ProviderUsageSnapshot[]>();
		const withWindow = (queries: number, cost: number) =>
			[
				{
					providerId: "claude",
					providerLabel: "Claude",
					windows: [
						{
							windowId: "five_hour",
							label: "5-HOUR",
							windowSecs: 18_000,
							utilization: 0.55,
							remaining: null,
							limit: null,
							resetsAt: null,
							cost,
							queries,
							tokens: 0,
							sessions: queries > 0 ? 1 : 0,
						},
					],
				},
			] satisfies ProviderUsageSnapshot[];
		const fetchFn = vi
			.fn<() => Promise<ProviderUsageSnapshot[]>>()
			.mockReturnValueOnce(stale.promise)
			.mockReturnValueOnce(fresh.promise);
		const rateLimit = {
			type: "rate_limit" as const,
			status: "allowed",
			providerId: "claude",
			rateLimitType: "five_hour",
			utilization: 0.55,
		};
		const view = render(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={0}
				rateLimit={null}
				fetchFn={fetchFn}
			/>,
		);

		view.rerender(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={0}
				rateLimit={rateLimit}
				fetchFn={fetchFn}
			/>,
		);
		view.rerender(
			<ProviderUsageStrip
				initial={withWindow(0, 0)}
				liveQueryCount={1}
				rateLimit={rateLimit}
				fetchFn={fetchFn}
			/>,
		);

		await act(async () => fresh.resolve(withWindow(3, 17.24)));
		expect(screen.getByText("3 queries")).not.toBeNull();
		expect(screen.getByText("~$17.24")).not.toBeNull();

		await act(async () => stale.resolve(withWindow(0, 0)));
		expect(screen.getByText("3 queries")).not.toBeNull();
		expect(screen.queryByText("0 queries")).toBeNull();
	});

	it("refreshes every minute while the page is visible", () => {
		const fetchFn = renderStrip();

		vi.advanceTimersByTime(120_000);

		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("stops while hidden and refreshes immediately when visible again", () => {
		const fetchFn = renderStrip();

		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		vi.advanceTimersByTime(180_000);
		expect(fetchFn).not.toHaveBeenCalled();

		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(fetchFn).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(60_000);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("does not start an interval when initially hidden", () => {
		setVisibility("hidden");
		const fetchFn = renderStrip();

		vi.advanceTimersByTime(180_000);

		expect(fetchFn).not.toHaveBeenCalled();
	});
});
