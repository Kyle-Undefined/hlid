import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"scripts/**/*.test.ts",
		],
		// DB tests require bun:sqlite — run with `bun run test:db` instead
		exclude: ["src/**/*.bun.test.ts"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "json", "json-summary", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				"src/**/*.test.{ts,tsx}",
				"src/**/*.bun.test.ts",
				// Covered by the separate Bun test runner, which supports bun:sqlite.
				"src/db/**",
				// Generated or embedded artifacts are not authored coverage targets.
				"src/routeTree.gen.ts",
				"src/server/codexProtocol/**",
				"src/server/embedded-client.ts",
			],
			// Initial floor measured 2026-07-10: S 43.30, B 36.53, F 35.26, L 44.40.
			// Keep a small cross-platform margin and ratchet these values upward.
			thresholds: {
				statements: 42,
				branches: 35,
				functions: 34,
				lines: 43,
			},
		},
	},
	resolve: {
		alias: {
			"#": resolve(__dirname, "src"),
			"@": resolve(__dirname, "src"),
		},
	},
});
