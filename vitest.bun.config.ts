import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const maxWorkers = Math.max(1, Math.min(8, availableParallelism() - 1));

export default defineConfig({
	test: {
		environment: "node",
		maxWorkers,
		include: ["src/**/*.bun.test.ts", "scripts/**/*.bun.test.ts"],
		coverage: {
			provider: "istanbul",
			processingConcurrency: Math.min(4, maxWorkers),
			reporter: ["json"],
			reportsDirectory: "coverage/bun",
			include: [
				"src/db/**/*.ts",
				"src/lib/frontmatter.ts",
				"src/lib/updates.ts",
				"src/lib/vault.ts",
				"src/server/auth.ts",
				"src/server/skillImports.ts",
				"src/server/skillInstalls.ts",
				"src/server/skillPackage.ts",
			],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.bun.test.ts",
				"src/test/**",
				"src/**/__mocks__/**",
				"src/**/*.test-utils.ts",
			],
		},
	},
	resolve: {
		alias: {
			"#": resolve(import.meta.dirname, "src"),
			"@": resolve(import.meta.dirname, "src"),
			"bun:test": "vitest",
		},
	},
});
