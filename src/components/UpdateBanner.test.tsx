// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	pathname: "/raven",
	status: null as null | {
		current: string;
		latest: string | null;
		available: boolean;
		lastCheckedAt: number;
		cliUpdates?: Array<{
			id: "codex" | "claude";
			label: string;
			installedVersion: string | null;
			latestVersion: string | null;
			available: boolean;
			checkedAt: number;
		}>;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => (
		<a href="/forge">{children}</a>
	),
	useLocation: () => ({ pathname: state.pathname }),
}));

vi.mock("#/hooks/updateStore", () => ({
	fetchUpdateStatus: vi.fn().mockResolvedValue(undefined),
	getUpdateServerSnapshot: () => null,
	getUpdateSnapshot: () => state.status,
	subscribeUpdateStatus: () => () => {},
}));

import { UpdateBanner } from "./UpdateBanner";

afterEach(cleanup);

beforeEach(() => {
	localStorage.clear();
	state.pathname = "/raven";
	state.status = {
		current: "0.0.106",
		latest: "0.0.106",
		available: false,
		lastCheckedAt: Date.now(),
		cliUpdates: [],
	};
});

describe("UpdateBanner", () => {
	it("prompts when an installed provider CLI has an update", () => {
		state.status?.cliUpdates?.push({
			id: "codex",
			label: "Codex",
			installedVersion: "0.144.1",
			latestVersion: "0.144.2",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(screen.getByText("Codex CLI v0.144.2 available")).toBeTruthy();
	});

	it("prioritizes an Hlid update over a provider CLI update", () => {
		if (!state.status) throw new Error("missing status fixture");
		state.status.available = true;
		state.status.latest = "0.0.107";
		state.status.cliUpdates = [
			{
				id: "codex",
				label: "Codex",
				installedVersion: "0.144.1",
				latestVersion: "0.144.2",
				available: true,
				checkedAt: Date.now(),
			},
		];

		render(<UpdateBanner />);

		expect(screen.getByText("Hlid v0.0.107 available")).toBeTruthy();
	});

	it("leaves update details to Forge while already on that page", () => {
		state.pathname = "/forge";
		state.status?.cliUpdates?.push({
			id: "codex",
			label: "Codex",
			installedVersion: "0.144.1",
			latestVersion: "0.144.2",
			available: true,
			checkedAt: Date.now(),
		});

		render(<UpdateBanner />);

		expect(screen.queryByText(/Codex CLI/)).toBeNull();
	});
});
