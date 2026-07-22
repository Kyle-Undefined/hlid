import * as db from "../db";
import type { RoutineDelivery } from "../lib/routines";
import { executeHlidAgentTool } from "./hlidAgentTools";
import { executeObsidianAgentTool } from "./obsidianAgentTools";

export type RoutineDeliveryResult = {
	kind: RoutineDelivery["kind"];
	ok: boolean;
	error?: string;
	result?: string;
};

function safeFilename(name: string): string {
	const normalized = name
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
	return `${normalized || "routine-result"}.md`;
}

export async function deliverRoutineResult(options: {
	sessionId: string;
	routineName: string;
	agentCwd: string;
	deliveries: RoutineDelivery[];
}): Promise<RoutineDeliveryResult[]> {
	if (options.deliveries.length === 0) return [];
	const messages = await db.getSessionMessages(options.sessionId);
	const text = [...messages]
		.reverse()
		.find((message) => message.role === "assistant")?.text;
	if (!text) {
		return options.deliveries.map((delivery) => ({
			kind: delivery.kind,
			ok: false,
			error: "The Routine completed without an assistant response to deliver",
		}));
	}
	const results: RoutineDeliveryResult[] = [];
	for (const delivery of options.deliveries) {
		try {
			let result: string;
			switch (delivery.kind) {
				case "relic":
					result = await executeHlidAgentTool(
						"publish_relic",
						{
							filename: safeFilename(options.routineName),
							content: text,
							mime: "text/markdown",
							category: "report",
						},
						{ runtimeCwd: options.agentCwd, sessionId: options.sessionId },
					);
					break;
				case "daily_append":
					result = await executeObsidianAgentTool("append_note", {
						target: "daily",
						content: text,
					});
					break;
				case "capture":
					result = await executeObsidianAgentTool("capture_note", {
						content: text,
					});
					break;
				case "note_append":
					result = await executeObsidianAgentTool("append_note", {
						target: "path",
						path: delivery.path,
						content: text,
					});
					break;
			}
			results.push({ kind: delivery.kind, ok: true, result });
		} catch (error) {
			results.push({
				kind: delivery.kind,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}
