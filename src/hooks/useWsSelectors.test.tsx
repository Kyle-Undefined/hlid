// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextWindowSection } from "#/components/usage/UsageWindowSections";
import { useWsLiveStats } from "./useWsSelectors";
import {
	EMPTY_STATS,
	resetLiveStatsForTesting,
	seedContextStats,
} from "./wsLiveStatsStore";

function LiveContextWindow() {
	const stats = useWsLiveStats();
	return <ContextWindowSection stats={stats} />;
}

beforeEach(() => {
	sessionStorage.clear();
	resetLiveStatsForTesting();
});

afterEach(() => {
	resetLiveStatsForTesting();
	sessionStorage.clear();
});

describe("useWsLiveStats", () => {
	it("hydrates empty server stats before applying persisted client stats", async () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<ContextWindowSection stats={EMPTY_STATS} />,
		);
		document.body.append(container);

		seedContextStats(200_000, 2_820);
		expect(
			JSON.parse(sessionStorage.getItem("hlid:live_stats") ?? "{}"),
		).toMatchObject({
			context_window: 200_000,
			last_context_used: 2_820,
		});

		const recoverableErrors: unknown[] = [];
		let root: ReturnType<typeof hydrateRoot> | undefined;

		try {
			await act(async () => {
				root = hydrateRoot(container, <LiveContextWindow />, {
					onRecoverableError: (error) => recoverableErrors.push(error),
				});
				await Promise.resolve();
			});

			await waitFor(() => {
				expect(container.textContent).toContain("1%");
				expect(container.textContent).toContain("3k / 200k");
			});
			expect(recoverableErrors).toEqual([]);
			expect(container.textContent).not.toContain("no active context");
		} finally {
			await act(async () => root?.unmount());
			container.remove();
		}
	});
});
