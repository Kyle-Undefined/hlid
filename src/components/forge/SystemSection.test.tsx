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

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
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
});
