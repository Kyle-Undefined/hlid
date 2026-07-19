import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
	InstructionFileDocument,
	InstructionFileTarget,
} from "#/lib/instructionFileTypes";
import { getConfig } from "#/lib/serverFns/config";

const targetIdSchema = z.string().trim().min(1).max(128);

export const getInstructionFileTargetsFn = createServerFn({
	method: "GET",
}).handler(async (): Promise<InstructionFileTarget[]> => {
	const { discoverInstructionFileTargets } = await import(
		"#/server/instructionFiles"
	);
	return discoverInstructionFileTargets(await getConfig());
});

export const readInstructionFileFn = createServerFn({ method: "GET" })
	.validator((raw) => targetIdSchema.parse(raw))
	.handler(async ({ data: id }): Promise<InstructionFileDocument> => {
		const { readInstructionFile } = await import("#/server/instructionFiles");
		return readInstructionFile(await getConfig(), id);
	});

export const writeInstructionFileFn = createServerFn({ method: "POST" })
	.validator((raw) =>
		z
			.object({
				id: targetIdSchema,
				content: z.string().max(1024 * 1024),
				expectedRevision: z.string().length(64).nullable(),
			})
			.parse(raw),
	)
	.handler(async ({ data }): Promise<InstructionFileDocument> => {
		const { writeInstructionFile } = await import("#/server/instructionFiles");
		return writeInstructionFile(await getConfig(), data);
	});
