import { createServerFn } from "@tanstack/react-start";
import {
	LocalAiSetupMutationSchema,
	type LocalAiSetupSnapshot,
} from "#/lib/localAiSetup";

async function coordinator() {
	return (await import("#/server/localAiSetup")).localAiSetup;
}

export const getLocalAiSetupFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<LocalAiSetupSnapshot> => (await coordinator()).snapshot(),
);

export const mutateLocalAiSetupFn = createServerFn({ method: "POST" })
	.validator((raw) => LocalAiSetupMutationSchema.parse(raw))
	.handler(
		async ({ data }): Promise<LocalAiSetupSnapshot> =>
			(await coordinator()).mutate(data),
	);
