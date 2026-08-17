/** Local neural speech status and download management server fns. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { dbFetch, dbJson, requireDbOk } from "#/lib/dbClient";
import type { TtsModelInfo, TtsStatus } from "#/server/tts";

const parseModelName = (raw: string) => z.string().min(1).parse(raw);

export type TtsInfo = {
	status: TtsStatus;
	models: TtsModelInfo[];
	runtime?: {
		directml: {
			supported: boolean;
			installed: boolean;
			runtimeId: string;
		};
	};
};

export const getTtsInfoFn = createServerFn({ method: "GET" }).handler(() =>
	dbJson<TtsInfo>("/tts", {
		status: {
			state: "unavailable",
			model: "",
			error: "local neural speech service unavailable",
		},
		models: [],
	}),
);

export const syncTtsConfigFn = createServerFn({ method: "POST" }).handler(
	async () => {
		await requireDbOk(
			await dbFetch("/tts/sync", { method: "POST" }),
			"sync local neural speech",
		);
		return { ok: true };
	},
);

export const startTtsDownloadFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch("/tts/download", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: data }),
			}),
			"start local neural speech download",
		);
		return { ok: true };
	});

export const cancelTtsDownloadFn = createServerFn({ method: "POST" }).handler(
	async () => {
		await requireDbOk(
			await dbFetch("/tts/download/cancel", { method: "POST" }),
			"cancel local neural speech download",
		);
		return { ok: true };
	},
);

export const deleteTtsModelFn = createServerFn({ method: "POST" })
	.validator(parseModelName)
	.handler(async ({ data }) => {
		await requireDbOk(
			await dbFetch(`/tts/model?model=${encodeURIComponent(data)}`, {
				method: "DELETE",
			}),
			"delete local neural speech model",
		);
		return { ok: true };
	});
