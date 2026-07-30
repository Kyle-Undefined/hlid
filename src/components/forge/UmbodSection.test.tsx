// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "#/config";
import {
	getDataRevisionSnapshot,
	replaceDataRevisions,
	resetDataRevisionsForTesting,
} from "#/hooks/wsDataRevisionStore";
import { UmbodSection } from "./UmbodSection";

const manifestPanelState = vi.hoisted(() => ({
	onSaved: null as null | (() => Promise<void>),
}));

vi.mock("#/components/forge/UmbodHooksPanel", () => ({
	UmbodHooksPanel: () => <div>Hooks</div>,
}));

vi.mock("#/components/forge/UmbodManifestPanel", () => ({
	UmbodManifestPanel: ({ onSaved }: { onSaved: () => Promise<void> }) => {
		manifestPanelState.onSaved = onSaved;
		return <div>Manifest</div>;
	},
}));

vi.mock("#/components/forge/UmbodDashboard", () => ({
	UmbodDashboard: () => <div>Dashboard</div>,
}));

const value = {
	enabled: true,
	manifest_path: "/vault/umbod.toml",
} as HlidConfig["umbod"];

async function flushRequests() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	resetDataRevisionsForTesting();
	manifestPanelState.onSaved = null;
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("UmbodSection", () => {
	it("debounces activity revisions into one forced analytics refresh", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("view=analytics"))
				return Response.json({
					enabled: true,
					tools: { totals: { entries: 1 } },
				});
			return Response.json({ enabled: true, source: "[rules]" });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<UmbodSection value={value} onChange={vi.fn()} />);
		await flushRequests();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/umbod");
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/umbod?view=analytics");

		act(() => {
			replaceDataRevisions({
				...getDataRevisionSnapshot(),
				umbod: getDataRevisionSnapshot().umbod + 1,
			});
		});
		await flushRequests();
		act(() => {
			vi.advanceTimersByTime(400);
			replaceDataRevisions({
				...getDataRevisionSnapshot(),
				umbod: getDataRevisionSnapshot().umbod + 1,
			});
		});
		await flushRequests();
		act(() => vi.advanceTimersByTime(499));
		expect(fetchMock).toHaveBeenCalledTimes(2);

		act(() => vi.advanceTimersByTime(1));
		await flushRequests();

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/umbod");
		expect(fetchMock).toHaveBeenNthCalledWith(
			4,
			"/api/umbod?view=analytics&refresh=1",
		);
	});

	it("refreshes immediately after a save and cancels a pending activity reload", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("view=analytics"))
				return Response.json({ enabled: true, rules: { rules: [] } });
			return Response.json({ enabled: true, source: "[rules]" });
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<UmbodSection value={value} onChange={vi.fn()} />);
		await flushRequests();

		act(() => {
			replaceDataRevisions({
				...getDataRevisionSnapshot(),
				umbod: getDataRevisionSnapshot().umbod + 1,
			});
		});
		await flushRequests();

		await act(async () => {
			await manifestPanelState.onSaved?.();
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/umbod?view=analytics&refresh=1",
		);

		act(() => vi.advanceTimersByTime(500));
		await flushRequests();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});
