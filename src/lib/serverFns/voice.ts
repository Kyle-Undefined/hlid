/** Voice model status and download management server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import { optionalRefreshSchema, withRefreshQuery } from "#/lib/serverFnSchemas";
import type { VoiceModelInfo, VoiceStatus } from "#/server/voice";

const parseModelName = (raw: string) => z.string().min(1).parse(raw);

export type VoiceInfo = { status: VoiceStatus; models: VoiceModelInfo[] };

export const getVoiceInfoFn = createServerFn({ method: "GET" })
	.validator((raw) => optionalRefreshSchema.parse(raw))
	.handler(({ data }) =>
		dbJson<VoiceInfo>(withRefreshQuery("/voice", data), {
			status: {
				state: "unavailable",
				model: "",
				error: "voice service unavailable",
			},
			models: [],
		}),
	);

export const startVoiceDownloadFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch("/voice/download", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: data }),
			}),
			"start voice model download",
		);
		return { ok: true };
	});

export const cancelVoiceDownloadFn = createServerFn({ method: "POST" }).handler(
	async () => {
		await requireDbOk(
			await dbFetch("/voice/download/cancel", { method: "POST" }),
			"cancel voice model download",
		);
		return { ok: true };
	},
);

export const deleteVoiceModelFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/voice/model?model=${encodeURIComponent(data)}`, {
				method: "DELETE",
			}),
			"delete voice model",
		);
		return { ok: true };
	});
