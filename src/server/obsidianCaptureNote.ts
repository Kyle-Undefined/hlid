import { randomUUID } from "node:crypto";
import type { HlidConfig } from "#/config";
import {
	configuredObsidianCapture,
	obsidianCaptureNotePath,
} from "#/lib/obsidianCapture";
import { createObsidianNote } from "./obsidianCli";

type CaptureDependencies = {
	now?: () => Date;
	nonce?: () => string;
	createNote?: typeof createObsidianNote;
};

export async function captureObsidianNote(
	vault: HlidConfig["vault"],
	input: { content: string; open?: boolean },
	dependencies: CaptureDependencies = {},
): Promise<{
	path: string;
	destination: "Inbox" | "Raw";
	template: string | null;
}> {
	const destination = configuredObsidianCapture(vault);
	if (!destination) {
		throw new Error(
			"This workspace does not have an Obsidian Inbox or Raw folder configured.",
		);
	}
	const requestedPath = obsidianCaptureNotePath(
		destination,
		(dependencies.now ?? (() => new Date()))(),
		(dependencies.nonce ?? randomUUID)(),
	);
	const result = await (dependencies.createNote ?? createObsidianNote)(
		vault.name,
		{
			path: requestedPath,
			template: destination.template ?? undefined,
			content: input.content,
			open: input.open,
		},
	);
	return {
		path: result.path,
		destination: destination.label,
		template: destination.template,
	};
}
