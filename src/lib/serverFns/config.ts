import { createServerFn } from "@tanstack/react-start";

export const getConfig = createServerFn({ method: "GET" }).handler(async () => {
	const { loadConfig } = await import("#/server/config");
	const { publicConfig } = await import("#/lib/publicConfig");
	return publicConfig(loadConfig());
});
