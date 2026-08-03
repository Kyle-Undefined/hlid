// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyStore from "#/hooks/privacyStore";
import type { ToolEventMessage } from "#/server/protocol";

const { mockLoadToolEventDetail } = vi.hoisted(() => ({
	mockLoadToolEventDetail: vi.fn(),
}));

vi.mock("#/hooks/toolEventDetailStore", () => ({
	loadToolEventDetail: mockLoadToolEventDetail,
}));

import {
	GeneratedMediaToolBlock,
	isGeneratedMediaToolEvent,
	parseGeneratedMediaResult,
} from "./GeneratedMediaToolBlock";

afterEach(cleanup);
beforeEach(() => {
	privacyStore.__resetForTesting();
	mockLoadToolEventDetail.mockReset();
});

const READY_RESULT = JSON.stringify({
	type: "hlid_generated_media",
	version: 1,
	status: "ready",
	provider: "codex",
	provider_item_id: "image-1",
	attachment_id: "generated-attachment-1",
	filename: "image-1.png",
	mime: "image/png",
	size_bytes: 4_096,
	width: 1_024,
	height: 768,
	prompt: "A quiet mountain lake",
});

function event(overrides: Partial<ToolEventMessage> = {}): ToolEventMessage {
	return {
		type: "tool_event",
		id: "image-1",
		name: "ImageGeneration",
		input: { type: "imageGeneration", status: "inProgress" },
		result: READY_RESULT,
		...overrides,
	};
}

describe("parseGeneratedMediaResult", () => {
	it("accepts Hlid's compact generated-media receipt", () => {
		expect(parseGeneratedMediaResult(READY_RESULT)).toMatchObject({
			status: "ready",
			attachment_id: "generated-attachment-1",
			filename: "image-1.png",
			width: 1_024,
			height: 768,
		});
		expect(isGeneratedMediaToolEvent(event())).toBe(true);
		expect(isGeneratedMediaToolEvent(event({ name: "imageGeneration" }))).toBe(
			true,
		);
	});

	it.each([
		"not json",
		JSON.stringify({ type: "other" }),
		JSON.stringify({
			...JSON.parse(READY_RESULT),
			attachment_id: "../../secret",
		}),
		JSON.stringify({ ...JSON.parse(READY_RESULT), filename: "../image.png" }),
		JSON.stringify({ ...JSON.parse(READY_RESULT), mime: "image/svg+xml" }),
		JSON.stringify({ ...JSON.parse(READY_RESULT), width: 20_000 }),
	])("rejects malformed or unsafe receipts", (result) => {
		expect(parseGeneratedMediaResult(result)).toBeNull();
	});
});

describe("GeneratedMediaToolBlock", () => {
	it("renders an inline durable image with download and Relics actions", () => {
		const { container } = render(<GeneratedMediaToolBlock event={event()} />);

		expect(screen.getByText("Generated image")).not.toBeNull();
		expect(screen.getByText("1,024 × 768")).not.toBeNull();
		expect(screen.getByText("4.0 KB")).not.toBeNull();
		expect(screen.getByText("A quiet mountain lake")).not.toBeNull();
		expect(screen.getByRole("img").getAttribute("src")).toBe(
			"/api/attachments/generated-attachment-1/raw",
		);
		expect(
			screen.getByRole("link", { name: /Download/ }).getAttribute("download"),
		).toBe("image-1.png");
		expect(
			screen.getByRole("link", { name: "Relics" }).getAttribute("href"),
		).toBe("/relics");
		expect(
			container.querySelector(
				"[data-generated-media='generated-attachment-1']",
			),
		).not.toBeNull();
	});

	it("unmounts and restores the image when its preview is collapsed", () => {
		render(<GeneratedMediaToolBlock event={event()} />);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Collapse generated image preview",
			}),
		);
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByRole("link", { name: /Download/ })).not.toBeNull();
		expect(screen.getByRole("link", { name: "Relics" })).not.toBeNull();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Expand generated image preview",
			}),
		);
		expect(screen.getByRole("img")).not.toBeNull();
	});

	it("expands a long prompt into a bounded scroll region", () => {
		render(<GeneratedMediaToolBlock event={event()} />);
		const prompt = screen.getByText("A quiet mountain lake");

		expect(prompt.className).toContain("line-clamp-3");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Expand generated image prompt",
			}),
		);
		expect(prompt.className).toContain("overflow-y-auto");
		expect(prompt.className).not.toContain("line-clamp-3");
		expect(
			screen.getByRole("button", {
				name: "Collapse generated image prompt",
			}),
		).not.toBeNull();
	});

	it("shows a truthful generating state before the provider result arrives", () => {
		render(<GeneratedMediaToolBlock event={event({ result: undefined })} />);
		expect(screen.getByText("Generating image…")).not.toBeNull();
	});

	it("hydrates a compact generated-media receipt when its preview is truncated", async () => {
		mockLoadToolEventDetail.mockResolvedValueOnce({
			result: READY_RESULT,
			isError: false,
		});
		render(
			<GeneratedMediaToolBlock
				event={event({
					result: READY_RESULT.slice(0, 256),
					resultTruncated: true,
					detailSessionId: "session-1",
				})}
			/>,
		);

		expect(screen.getByText("Loading generated image…")).not.toBeNull();
		await waitFor(() =>
			expect(screen.getByText("Generated image")).not.toBeNull(),
		);
		expect(mockLoadToolEventDetail).toHaveBeenCalledWith(
			"session-1",
			"image-1",
		);
	});

	it("shows a bounded failure receipt", () => {
		render(
			<GeneratedMediaToolBlock
				event={event({
					isError: true,
					result: JSON.stringify({
						type: "hlid_generated_media",
						version: 1,
						status: "failed",
						provider: "codex",
						provider_item_id: "image-1",
						failure_stage: "provider",
						error: "Generation was refused.",
					}),
				})}
			/>,
		);
		expect(screen.getByText("Generated image unavailable")).not.toBeNull();
		expect(screen.getByText("Generation was refused.")).not.toBeNull();
	});
});
