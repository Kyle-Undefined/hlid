// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemSection } from "./SystemSection";

const serverFns = vi.hoisted(() => ({
	getStorageStatsFn: vi.fn().mockResolvedValue({
		databaseBytes: 1024,
		walBytes: 0,
		reclaimableBytes: 0,
		trackedAttachmentBytes: 0,
		trackedAttachments: 0,
		sessions: 1,
		messages: 2,
		usageQueries: 3,
	}),
	optimizeStorageFn: vi.fn(),
}));

vi.mock("#/lib/serverFns", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/serverFns")>()),
	...serverFns,
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	serverFns.getStorageStatsFn.mockClear();
	serverFns.optimizeStorageFn.mockReset();
});

function jsonResponse(data: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: vi.fn().mockResolvedValue(data),
	} as unknown as Response;
}

describe("SystemSection", () => {
	it("loads lifecycle state and performs install, folder, and shutdown actions", async () => {
		const actions: string[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (!init?.method) {
					return jsonResponse({
						ok: true,
						data: {
							enabled: true,
							supported: true,
							install: {
								exe: "C:/hlid/hlid.exe",
								dir: "C:/hlid",
								canonical_exe: "C:/hlid/hlid.exe",
								canonical_dir: "C:/hlid",
								is_canonical: true,
							},
						},
					});
				}
				const action = JSON.parse(String(init.body)).action as string;
				actions.push(action);
				return jsonResponse({ ok: true });
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		render(<SystemSection />);

		await screen.findByText("C:/hlid");
		fireEvent.click(screen.getByText("OPEN"));
		await waitFor(() => expect(actions).toContain("open_install_dir"));

		fireEvent.click(screen.getByRole("checkbox"));
		await waitFor(() => expect(actions).toContain("uninstall"));

		fireEvent.click(screen.getByText("SHUTDOWN"));
		fireEvent.click(screen.getByText("confirm"));
		await waitFor(() => expect(actions).toContain("shutdown"));
	});

	it("shows unsupported and failed lifecycle states", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ ok: true, data: { enabled: false, supported: false } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const { unmount } = render(<SystemSection />);
		await screen.findByText("Windows only");
		expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
			true,
		);
		unmount();

		fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
		render(<SystemSection />);
		await screen.findByText("Failed to load lifecycle state");
	});

	it("surfaces maintenance failures and restores the optimize action", async () => {
		serverFns.optimizeStorageFn.mockRejectedValueOnce(
			new Error("database is busy"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					ok: true,
					data: { enabled: false, supported: true },
				}),
			),
		);
		render(<SystemSection view="advanced" />);

		fireEvent.click(screen.getByText("OPTIMIZE"));
		await screen.findByText("database is busy");
		expect(screen.getByText("OPTIMIZE")).not.toBeNull();
	});

	it("shows lifecycle POST failures instead of reporting shutdown success", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method
					? jsonResponse({}, false, 503)
					: jsonResponse({
							ok: true,
							data: { enabled: false, supported: true },
						}),
		);
		vi.stubGlobal("fetch", fetchMock);
		render(<SystemSection view="advanced" />);

		fireEvent.click(screen.getByText("SHUTDOWN"));
		fireEvent.click(screen.getByText("confirm"));
		await screen.findByText("Request failed with status 503");
		expect(screen.getByText("SHUTDOWN")).not.toBeNull();
	});
});
