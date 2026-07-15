import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const maxWorkers = Math.max(1, Math.min(8, availableParallelism() - 1));

export default defineConfig({
	test: {
		environment: "node",
		maxWorkers,
		include: ["src/**/*.bun.test.ts"],
		coverage: {
			provider: "istanbul",
			processingConcurrency: Math.min(4, maxWorkers),
			reporter: ["json"],
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
