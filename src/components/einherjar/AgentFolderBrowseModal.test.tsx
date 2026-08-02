// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFolderBrowseModal } from "./AgentFolderBrowseModal";

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => new Promise(() => {})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AgentFolderBrowseModal", () => {
	it("dismisses from the backdrop without closing from dialog content", () => {
		const onClose = vi.fn();
		render(
			<AgentFolderBrowseModal
				initialPath="/workspace"
				externalAllowed
				onSelect={vi.fn()}
				onClose={onClose}
			/>,
		);
		const dialog = screen.getByRole("dialog", {
			name: "SELECT AGENT DIRECTORY",
		});

		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.click(dialog.parentElement as HTMLElement);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("ignores a folder response that settles after dismissal", async () => {
		const response = Promise.withResolvers<Response>();
		const request = vi.fn(() => response.promise);
		vi.stubGlobal("fetch", request);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const view = render(
			<AgentFolderBrowseModal
				initialPath="/workspace"
				externalAllowed
				onSelect={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await waitFor(() => expect(request).toHaveBeenCalledOnce());

		view.unmount();
		await act(async () => {
			response.resolve({
				json: () => Promise.resolve({ path: "/workspace", entries: [] }),
			} as Response);
			await response.promise;
			await Promise.resolve();
		});

		expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
			"hasn't mounted yet",
		);
	});
});
