export async function readVoiceTranscriptionResponse(
	response: Response,
): Promise<{ text: string }> {
	const raw = await response.text();
	let result: { text?: string; error?: string } = {};
	try {
		result = JSON.parse(raw) as typeof result;
	} catch {}
	if (!response.ok) {
		if (result.error) throw new Error(result.error);
		if (response.status === 404) {
			throw new Error(
				"Voice transcription is unavailable in this Hlid build. Restart Hlid after installing the latest build.",
			);
		}
		throw new Error(
			`voice service returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}
	if (!raw || typeof result.text !== "string") {
		throw new Error("voice service returned an invalid response");
	}
	return { text: result.text };
}
