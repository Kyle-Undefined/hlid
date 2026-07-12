/** Client-side error logging server fn. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const logClientErrorSchema = z.object({
	message: z
		.string()
		.min(1)
		.transform((s) => s.slice(0, 10_000)),
	componentStack: z
		.string()
		.transform((s) => s.slice(0, 50_000))
		.optional(),
});

/** Write a client-side error to the server event log. Fire-and-forget from ErrorBoundary. */
export const logClientErrorFn = createServerFn({ method: "POST" })
	.validator((raw) => logClientErrorSchema.parse(raw))
	.handler(async ({ data }) => {
		const { appendLog } = await import("#/db");
		await appendLog("error", "ui", data.message, {
			componentStack: data.componentStack,
		});
	});
