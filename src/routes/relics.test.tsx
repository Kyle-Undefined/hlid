// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentRow } from "#/db";

const ws = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock("#/hooks/useWs", () => ({
	useWs: (handler: (message: unknown) => void) => ws.handler(handler),
}));

// Row session links render outside a RouterProvider in these tests.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			children,
			...props
		}: {
			children?: React.ReactNode;
			[key: string]: unknown;
		}) => (
			<a
				href="#mock"
				aria-label={props["aria-label"] as string | undefined}
				title={props.title as string | undefined}
			>
				{children}
			</a>
		),
	};
});

import { AttachmentsPage, deleteRelicRows, RelicPreview } from "./relics";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	ws.handler.mockReset();
});

describe("AttachmentsPage", () => {
	it("searches from the first page and replaces list totals", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [rows[1]],
			total: 1,
			total_bytes: 4,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("filename…"), {
			target: { value: "  two  " },
		});
		fireEvent.keyDown(screen.getByPlaceholderText("filename…"), {
			key: "Enter",
		});
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: { search: "two", limit: 50, offset: 0 },
			}),
		);
		expect(await screen.findByText("two.pdf")).toBeDefined();
		expect(screen.queryByText("one.txt")).toBeNull();
		expect(screen.getByText(/1 file/)).toBeDefined();
	});

	it("searches live after a typing pause without pressing Enter", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [rows[1]],
			total: 1,
			total_bytes: 4,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("filename…"), {
			target: { value: "two" },
		});
		// no Enter — debounce commits on its own
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: { search: "two", limit: 50, offset: 0 },
			}),
		);
	});

	it("keeps existing rows visible when refresh fails", async () => {
		const listAttachments = vi
			.fn()
			.mockRejectedValue(new Error("attachment service unavailable"));
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(
			await screen.findByText("attachment service unavailable"),
		).toBeDefined();
		expect(screen.getByText("one.txt")).toBeDefined();
		expect(screen.getByText("two.pdf")).toBeDefined();
	});

	it("reports partial bulk deletion after refreshing the list", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 500 }));
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [rows[1]],
			total: 1,
			total_bytes: 4,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
				request={request}
			/>,
		);
		const checkboxes = screen.getAllByRole("checkbox");
		fireEvent.click(checkboxes[1]);
		fireEvent.click(checkboxes[2]);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "confirm" }));
		await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("Delete failed: two.pdf")).toBeDefined();
	});

	it("loads the next page with the correct offset", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [],
			total: 101,
			total_bytes: 7,
		});
		render(
			<AttachmentsPage
				initial={{ rows: [rows[0]], total: 101, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /next/i }));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: { search: undefined, limit: 50, offset: 50 },
			}),
		);
		expect(await screen.findByText("page 2 / 3")).toBeDefined();
	});

	it("shows a refresh pill instead of reloading when an attachment is created", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows,
			total: 2,
			total_bytes: 7,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		const handler = ws.handler.mock.calls[0][0];
		handler({ type: "attachment_created" });
		// No automatic reload — the user's page/selection stays put.
		expect(listAttachments).not.toHaveBeenCalled();
		const pill = await screen.findByRole("button", {
			name: /new relics — refresh/i,
		});
		fireEvent.click(pill);
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: { search: undefined, limit: 50, offset: 0 },
			}),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /new relics — refresh/i }),
			).toBeNull(),
		);
	});

	it("filters by MIME class via the type chips", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [rows[1]],
			total: 1,
			total_bytes: 4,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "PDF" }));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: { search: undefined, type: "pdf", limit: 50, offset: 0 },
			}),
		);
	});

	it("sorts by size and toggles direction on repeat clicks", async () => {
		const listAttachments = vi.fn().mockResolvedValue({
			rows,
			total: 2,
			total_bytes: 7,
		});
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Sort by Size" }));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: {
					search: undefined,
					sort: "size_bytes",
					dir: "desc",
					limit: 50,
					offset: 0,
				},
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Sort by Size" }));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: {
					search: undefined,
					sort: "size_bytes",
					dir: "asc",
					limit: 50,
					offset: 0,
				},
			}),
		);
	});

	it("filters by session and clears via the chip", async () => {
		const withSession = { ...rows[0], session_id: "sess-1234567890ab" };
		const listAttachments = vi.fn().mockResolvedValue({
			rows: [withSession],
			total: 1,
			total_bytes: 3,
		});
		render(
			<AttachmentsPage
				initial={{ rows: [withSession], total: 1, total_bytes: 3 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.click(screen.getByTitle("Filter by this session"));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				data: {
					search: undefined,
					session_id: "sess-1234567890ab",
					limit: 50,
					offset: 0,
				},
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Clear session filter" }),
		);
		await waitFor(() =>
			expect(listAttachments).toHaveBeenLastCalledWith({
				data: { search: undefined, limit: 50, offset: 0 },
			}),
		);
	});

	it("offers clear filters in the empty state when filters are active", async () => {
		const listAttachments = vi
			.fn()
			.mockResolvedValueOnce({ rows: [], total: 0, total_bytes: 0 })
			.mockResolvedValue({ rows, total: 2, total_bytes: 7 });
		render(
			<AttachmentsPage
				initial={{ rows, total: 2, total_bytes: 7 }}
				listAttachments={listAttachments}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("filename…"), {
			target: { value: "nope" },
		});
		fireEvent.keyDown(screen.getByPlaceholderText("filename…"), {
			key: "Enter",
		});
		expect(await screen.findByText(/no relics match filters/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "clear filters" }));
		await waitFor(() =>
			expect(listAttachments).toHaveBeenLastCalledWith({
				data: { search: undefined, limit: 50, offset: 0 },
			}),
		);
		expect(
			(screen.getByPlaceholderText("filename…") as HTMLInputElement).value,
		).toBe("");
	});
});

const rows: AttachmentRow[] = [
	{
		id: "one",
		session_id: null,
		message_seq: null,
		kind: "ephemeral",
		filename: "one.txt",
		path: "/tmp/one.txt",
		mime: "text/plain",
		size_bytes: 3,
		sha256: null,
		created_at: 1,
	},
	{
		id: "two",
		session_id: null,
		message_seq: null,
		kind: "vault",
		filename: "two.pdf",
		path: "/tmp/two.pdf",
		mime: "application/pdf",
		size_bytes: 4,
		sha256: null,
		created_at: 2,
	},
];

describe("deleteRelicRows", () => {
	it("deletes known rows in order and reports only failed filenames", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 500 }));
		await expect(
			deleteRelicRows(["one", "missing", "two"], rows, request),
		).resolves.toEqual(["two.pdf"]);
		expect(request.mock.calls).toEqual([
			["/api/attachments/one", { method: "DELETE" }],
			["/api/attachments/two", { method: "DELETE" }],
		]);
	});

	it("does nothing when no selected IDs resolve to rows", async () => {
		const request = vi.fn<typeof fetch>();
		await expect(deleteRelicRows(["missing"], rows, request)).resolves.toEqual(
			[],
		);
		expect(request).not.toHaveBeenCalled();
	});
});

describe("RelicPreview", () => {
	it("renders sandboxed HTML without fetching its contents into the app", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		render(<RelicPreview id="html-1" mime="text/html" />);
		const frame = screen.getByTitle("html preview") as HTMLIFrameElement;
		expect(frame.getAttribute("src")).toBe("/api/attachments/html-1/raw");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fetches and renders text previews", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("hello relic"),
		);
		render(<RelicPreview id="text-1" mime="text/plain" />);
		expect(await screen.findByText("hello relic")).toBeDefined();
	});

	it("shows text fetch failures instead of an empty preview", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("no", { status: 503, statusText: "Unavailable" }),
		);
		render(<RelicPreview id="text-1" mime="application/json" />);
		await waitFor(() =>
			expect(
				screen.getByText(/fetch failed \(503 Unavailable\)/),
			).toBeDefined(),
		);
	});

	it("renders PDF and unsupported-type fallbacks without fetching", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { rerender } = render(
			<RelicPreview id="pdf-1" mime="application/pdf" />,
		);
		expect(screen.getByTitle("pdf preview").getAttribute("src")).toBe(
			"/api/attachments/pdf-1/raw",
		);
		rerender(<RelicPreview id="zip-1" mime="application/zip" />);
		expect(screen.getByText("no preview")).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
