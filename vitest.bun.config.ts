import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.bun.test.ts"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "json"],
			reportsDirectory: "coverage/bun",
			include: ["src/db/**/*.ts", "src/server/auth.ts"],
			exclude: ["src/**/*.test.ts", "src/**/*.bun.test.ts"],
		},
	},
	resolve: {
		alias: {
			"#": resolve(__dirname, "src"),
			"@": resolve(__dirname, "src"),
			"bun:test": "vitest",
		},
	},
});
