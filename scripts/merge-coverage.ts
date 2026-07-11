import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCoverageMap } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";

const root = resolve(import.meta.dir, "..");
const outputDir = resolve(root, "coverage");
const inputs = [
	resolve(outputDir, "vitest", "coverage-final.json"),
	resolve(outputDir, "bun", "coverage-final.json"),
];

const coverage = createCoverageMap({});
for (const path of inputs) {
	coverage.merge(JSON.parse(readFileSync(path, "utf8")));
}

const context = createContext({ dir: outputDir, coverageMap: coverage });
for (const reporter of ["json", "json-summary", "html", "text-summary"] as const) {
	reports.create(reporter).execute(context);
}
