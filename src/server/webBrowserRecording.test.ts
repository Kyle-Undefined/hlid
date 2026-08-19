import { describe, expect, it } from "vitest";
import { buildWebBrowserRecordingHtml } from "./webBrowserRecording";

describe("Browser interaction replay", () => {
	it("builds a self-contained bounded replay without executable page metadata", () => {
		const html = buildWebBrowserRecordingHtml({
			previewId: "preview-1",
			sessionId: "session-1",
			startedAt: 1_000,
			endedAt: 2_500,
			truncated: false,
			frames: [
				{
					capturedAt: 1_500,
					url: "https://example.com/<script>alert(1)</script>",
					title: "Unsafe </script><script>alert(2)</script>",
					width: 1440,
					height: 1000,
					mime: "image/png",
					imageBase64: "AQID",
					action: "click",
				},
			],
		});

		expect(html).toContain("<!doctype html>");
		expect(html).toContain("data:image/png;base64,AQID");
		expect(html).toContain("\\u003cscript>alert(1)");
		expect(html).not.toContain("</script><script>alert(2)</script>");
		expect(html).not.toMatch(/https?:\/\/[^<]*src=/);
	});
});
