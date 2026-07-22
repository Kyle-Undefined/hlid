import { resolve } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { RoutineRunRow } from "#/db";
import { dbFetch, requireDbOk } from "#/lib/dbClient";
import { previewRoutineOccurrences } from "#/lib/routineSchedule";
import {
	routineCreateSchema,
	routineIdSchema,
	routineListSchema,
	routineScheduleSchema,
	routineUpdateSchema,
} from "#/lib/routines";

const previewSchema = z.object({
	schedule: routineScheduleSchema,
	timezone: z.string().trim().min(1).max(128),
	after: z.number().int().nonnegative().optional(),
});

const enableSchema = z.object({ id: routineIdSchema, enabled: z.boolean() });
const historySchema = z.object({
	id: routineIdSchema,
	limit: z.number().int().min(1).max(200).optional(),
});

async function validateRoutineTarget(agentCwd: string): Promise<void> {
	const { loadConfig } = await import("#/server/config");
	const config = loadConfig();
	const target = resolve(agentCwd);
	const allowed = [
		config.vault.path,
		...(config.agents ?? []).map((a) => a.path),
	]
		.filter(Boolean)
		.some((path) => resolve(path) === target);
	if (!allowed) {
		throw new Error(
			"Routine target must be the configured vault or a registered agent",
		);
	}
}

async function notifyRoutineChange(): Promise<void> {
	try {
		await requireDbOk(
			await dbFetch("/routines/changed", { method: "POST" }),
			"Refresh Routines",
		);
	} catch (error) {
		console.warn(
			"[routines] saved but live refresh failed:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export const previewRoutineScheduleFn = createServerFn({ method: "POST" })
	.validator((raw) => previewSchema.parse(raw))
	.handler(({ data }) =>
		previewRoutineOccurrences(
			data.schedule,
			data.timezone,
			data.after ?? Math.floor(Date.now() / 1_000),
			3,
		),
	);

export const listRoutinesFn = createServerFn({ method: "GET" })
	.validator((raw) => routineListSchema.parse(raw ?? {}))
	.handler(async ({ data }) => {
		const { listRoutines } = await import("#/db");
		return listRoutines(data);
	});

export const createRoutineFn = createServerFn({ method: "POST" })
	.validator((raw) => routineCreateSchema.parse(raw))
	.handler(async ({ data }) => {
		await validateRoutineTarget(data.agentCwd);
		const { createRoutine } = await import("#/db/routines");
		const routine = await createRoutine(data);
		await notifyRoutineChange();
		return routine;
	});

export const updateRoutineFn = createServerFn({ method: "POST" })
	.validator((raw) => routineUpdateSchema.parse(raw))
	.handler(async ({ data }) => {
		await validateRoutineTarget(data.definition.agentCwd);
		const { updateRoutine } = await import("#/db/routines");
		const routine = await updateRoutine(data.id, data.definition);
		await notifyRoutineChange();
		return routine;
	});

export const setRoutineEnabledFn = createServerFn({ method: "POST" })
	.validator((raw) => enableSchema.parse(raw))
	.handler(async ({ data }) => {
		const { setRoutineEnabled } = await import("#/db/routines");
		const routine = await setRoutineEnabled(data.id, data.enabled);
		await notifyRoutineChange();
		return routine;
	});

export const archiveRoutineFn = createServerFn({ method: "POST" })
	.validator((raw) => routineIdSchema.parse(raw))
	.handler(async ({ data }) => {
		const { archiveRoutine } = await import("#/db/routines");
		await archiveRoutine(data);
		await notifyRoutineChange();
		return { ok: true };
	});

export const runRoutineNowFn = createServerFn({ method: "POST" })
	.validator((raw) => routineIdSchema.parse(raw))
	.handler(async ({ data }) => {
		const response = await requireDbOk(
			await dbFetch("/routines/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: data }),
			}),
			"Run Routine",
		);
		return (await response.json()) as RoutineRunRow;
	});

export const getRoutineRunsFn = createServerFn({ method: "GET" })
	.validator((raw) => historySchema.parse(raw))
	.handler(async ({ data }) => {
		const { listRoutineRuns } = await import("#/db/routines");
		return listRoutineRuns(data.id, data.limit);
	});
