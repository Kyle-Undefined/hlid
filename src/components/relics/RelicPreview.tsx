import { useEffect, useState } from "react";
import { ClickableImage } from "#/components/ImageViewerModal";
import { MarkdownBody } from "#/components/MarkdownBody";

export function relicRawUrl(
	id: string,
	visualizationSessionId?: string | null,
): string {
	const base = `/api/attachments/${encodeURIComponent(id)}/raw`;
	return visualizationSessionId
		? `${base}?visualization_session_id=${encodeURIComponent(visualizationSessionId)}`
		: base;
}

function TextPreview({ rawUrl, mime }: { rawUrl: string; mime: string }) {
	const [text, setText] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		fetch(rawUrl, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) {
					throw new Error(
						`fetch failed (${response.status} ${response.statusText})`,
					);
				}
				return response.text();
			})
			.then(setText)
			.catch((cause) => {
				if (cause instanceof Error && cause.name === "AbortError") return;
				setError(cause instanceof Error ? cause.message : "fetch failed");
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [rawUrl]);

	if (loading) {
		return (
			<span className="text-[11px] text-muted-foreground/50">loading…</span>
		);
	}
	if (error) {
		return <span className="text-[11px] text-destructive/70">{error}</span>;
	}
	if (text === null) return null;
	if (mime === "text/markdown") return <MarkdownBody content={text} />;
	return (
		<pre className="font-mono text-[11px] whitespace-pre-wrap break-words">
			{text}
		</pre>
	);
}

export function RelicPreview({
	id,
	mime,
	visualizationSessionId,
}: {
	id: string;
	mime: string;
	visualizationSessionId?: string | null;
}) {
	const rawUrl = relicRawUrl(id, visualizationSessionId);
	if (mime.startsWith("image/")) {
		return (
			<ClickableImage src={rawUrl} alt="" className="max-h-96 max-w-full" />
		);
	}
	if (mime === "application/pdf") {
		return (
			<iframe
				src={rawUrl}
				className="h-96 w-full border-0"
				title="pdf preview"
			/>
		);
	}
	if (mime === "text/html") {
		return (
			<iframe
				src={rawUrl}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				className="h-96 w-full border-0 bg-white"
				title="html preview"
			/>
		);
	}
	if (mime.startsWith("text/") || mime === "application/json") {
		return <TextPreview rawUrl={rawUrl} mime={mime} />;
	}
	return (
		<span className="text-[11px] text-muted-foreground/50">no preview</span>
	);
}
