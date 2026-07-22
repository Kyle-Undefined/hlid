import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HlidConfig } from "../config";

const mocks = vi.hoisted(() => ({
	handleGeneratedRelicPublish: vi.fn(),
	handleUpload: vi.fn(),
	removeAttachment: vi.fn(),
	serveAttachment: vi.fn(),
	promoteAttachmentToObsidian: vi.fn(),
	openAttachmentInObsidian: vi.fn(),
	loadConfig: vi.fn(),
	broadcast: vi.fn(),
}));

vi.mock("./attachments", () => ({
	handleGeneratedRelicPublish: mocks.handleGeneratedRelicPublish,
	handleUpload: mocks.handleUpload,
	removeAttachment: mocks.removeAttachment,
	serveAttachment: mocks.serveAttachment,
	promoteAttachmentToObsidian: mocks.promoteAttachmentToObsidian,
	openAttachmentInObsidian: mocks.openAttachmentInObsidian,
}));
vi.mock("./config", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("./runState", () => ({ broadcast: mocks.broadcast }));

const { handleAttachmentRoute } = await import("./attachmentRoutes");
const fallbackConfig = { server: {} } as HlidConfig;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadConfig.mockReturnValue(fallbackConfig);
	mocks.handleGeneratedRelicPublish.mockResolvedValue(
		Response.json({ id: "relic-1" }),
	);
	mocks.handleUpload.mockResolvedValue(new Response("uploaded"));
	mocks.removeAttachment.mockResolvedValue(new Response("removed"));
	mocks.serveAttachment.mockResolvedValue(new Response("raw"));
	mocks.promoteAttachmentToObsidian.mockResolvedValue(
		Response.json({ ok: true }),
	);
	mocks.openAttachmentInObsidian.mockResolvedValue(Response.json({ ok: true }));
	mocks.broadcast.mockResolvedValue(undefined);
});

describe("attachment route dispatch", () => {
	it("returns null for unrelated paths", async () => {
		expect(
			await handleAttachmentRoute(
				new URL("http://localhost/api/other"),
				new Request("http://localhost/api/other"),
				fallbackConfig,
			),
		).toBeNull();
	});

	it("enforces methods for raw and delete routes", async () => {
		const raw = new URL("http://localhost/api/attachments/item/raw");
		const item = new URL("http://localhost/api/attachments/item");
		expect(
			(
				await handleAttachmentRoute(
					raw,
					new Request(raw, { method: "DELETE" }),
					fallbackConfig,
				)
			)?.status,
		).toBe(405);
		expect(
			(await handleAttachmentRoute(item, new Request(item), fallbackConfig))
				?.status,
		).toBe(405);
	});

	it("serves safe attachment ids and rejects malformed ids", async () => {
		const url = new URL("http://localhost/api/attachments/item_1/raw");
		await handleAttachmentRoute(url, new Request(url), fallbackConfig);
		expect(mocks.serveAttachment).toHaveBeenCalledWith("item_1");
		const malformed = new URL("http://localhost/api/attachments/../secret/raw");
		expect(
			await handleAttachmentRoute(
				malformed,
				new Request(malformed),
				fallbackConfig,
			),
		).toBeNull();
	});

	it("uses fallback config when live config cannot be read", async () => {
		mocks.loadConfig.mockImplementation(() => {
			throw new Error("missing");
		});
		const url = new URL("http://localhost/api/attachments/item");
		await handleAttachmentRoute(
			url,
			new Request(url, { method: "DELETE" }),
			fallbackConfig,
		);
		expect(mocks.removeAttachment).toHaveBeenCalledWith("item", fallbackConfig);
	});

	it("promotes and opens safe attachment ids through Obsidian routes", async () => {
		const promoteUrl = new URL(
			"http://localhost/api/attachments/item_1/promote-to-obsidian",
		);
		const promote = await handleAttachmentRoute(
			promoteUrl,
			new Request(promoteUrl, { method: "POST" }),
			fallbackConfig,
		);
		expect(promote?.status).toBe(200);
		expect(mocks.promoteAttachmentToObsidian).toHaveBeenCalledWith(
			"item_1",
			fallbackConfig,
		);

		const openUrl = new URL(
			"http://localhost/api/attachments/item_1/open-in-obsidian",
		);
		const open = await handleAttachmentRoute(
			openUrl,
			new Request(openUrl, { method: "POST" }),
			fallbackConfig,
		);
		expect(open?.status).toBe(200);
		expect(mocks.openAttachmentInObsidian).toHaveBeenCalledWith(
			"item_1",
			fallbackConfig,
		);
	});

	it("publishes generated Relics and announces them through existing revisions", async () => {
		mocks.handleGeneratedRelicPublish.mockImplementation(
			async (
				_request: Request,
				_config: HlidConfig,
				published: (id: string) => Promise<void>,
			) => {
				await published("generated-1");
				return Response.json({ id: "generated-1" });
			},
		);
		const url = new URL("http://localhost/api/relics/publish");
		const response = await handleAttachmentRoute(
			url,
			new Request(url, { method: "POST", body: "{}" }),
			fallbackConfig,
		);

		expect(response?.status).toBe(200);
		expect(mocks.handleGeneratedRelicPublish).toHaveBeenCalledWith(
			expect.any(Request),
			fallbackConfig,
			expect.any(Function),
		);
		expect(mocks.broadcast).toHaveBeenCalledWith({
			type: "attachment_created",
			id: "generated-1",
			kind: "ephemeral",
		});
	});

	it("contains broadcast failures after a successful upload", async () => {
		mocks.broadcast.mockRejectedValue(new Error("closed"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.handleUpload.mockImplementation(
			async (
				_request: Request,
				_config: HlidConfig,
				created: (id: string, kind: string) => Promise<void>,
			) => {
				await created("new-id", "image");
				return new Response("uploaded");
			},
		);
		const url = new URL("http://localhost/api/attachments/upload");
		const response = await handleAttachmentRoute(
			url,
			new Request(url, { method: "POST" }),
			fallbackConfig,
		);
		expect(response?.status).toBe(200);
		expect(mocks.broadcast).toHaveBeenCalledWith({
			type: "attachment_created",
			id: "new-id",
			kind: "image",
		});
		warn.mockRestore();
	});
});
