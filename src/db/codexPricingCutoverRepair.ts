import type { Database } from "bun:sqlite";
import {
	OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER,
	resolvePricing,
} from "../lib/pricingCatalog";
import { isCliProxyProvider } from "../lib/providerIds";
import { isSyntheticModel } from "../lib/providerPricing";
import { rebuildUsageDate } from "./usageRepairShared";

export const CODEX_TERRA_LUNA_PRICING_MIGRATION =
	"_migrated_openai_terra_luna_pricing_2026_07_30";

export const OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER_SECONDS =
	Date.parse(`${OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER}T00:00:00.000Z`) / 1_000;

const PRICE_FACTORS: Readonly<Record<string, number>> = {
	"gpt-5.6-terra": 0.8,
	"gpt-5.6-luna": 0.2,
};

type CostRow = {
	id: number;
	session_id: string | null;
	timestamp: number;
	provider_id: string;
	model: string | null;
	selected_model: string | null;
	actual_model: string | null;
	session_model: string | null;
	estimated_cost: number;
	local_date: string;
};

export type CodexPricingCutoverRepairResult = {
	queryRows: number;
	usageQueryRows: number;
};

function concreteModel(model: string | null): string | null {
	const value = model?.trim();
	return value && !isSyntheticModel(value) ? value : null;
}

function routedModel(model: string): string {
	const withoutProvider = model.includes("/")
		? model.slice(model.indexOf("/") + 1)
		: model;
	return withoutProvider.replace(
		/\((?:none|auto|minimal|low|medium|high|xhigh|\d+)\)$/i,
		"",
	);
}

function pricingModel(row: CostRow): string | null {
	const recorded =
		concreteModel(row.model) ??
		concreteModel(row.selected_model) ??
		concreteModel(row.actual_model) ??
		concreteModel(row.session_model);
	if (!recorded) return null;
	return isCliProxyProvider(row.provider_id) ? routedModel(recorded) : recorded;
}

function repairRows(
	db: Database,
	table: "queries" | "usage_queries",
): { rows: number; sessionIds: Set<string>; dates: Set<string> } {
	const providerExpression =
		table === "queries"
			? "COALESCE(NULLIF(t.provider_id, ''), NULLIF(s.provider_id, ''), 'claude')"
			: "t.provider_id";
	const rows = db
		.query<CostRow, [number]>(`
			SELECT t.id, t.session_id, t.timestamp,
			       ${providerExpression} AS provider_id, t.model,
			       s.selected_model, s.actual_model, s.model AS session_model,
			       t.estimated_cost,
			       DATE(t.timestamp, 'unixepoch', 'localtime') AS local_date
			FROM ${table} t
			LEFT JOIN sessions s ON s.id = t.session_id
			WHERE t.timestamp >= ?
			  AND t.estimated_cost IS NOT NULL
			  AND (
			    LOWER(${providerExpression}) = 'codex'
			    OR LOWER(${providerExpression}) = 'cliproxy-codex'
			    OR LOWER(${providerExpression}) LIKE 'cliproxy:%'
			  )
		`)
		.all(OPENAI_GPT_56_TERRA_LUNA_PRICE_CUTOVER_SECONDS);
	const update = db.prepare(
		`UPDATE ${table} SET estimated_cost = ? WHERE id = ?`,
	);
	const sessionIds = new Set<string>();
	const dates = new Set<string>();
	let repaired = 0;

	for (const row of rows) {
		const model = pricingModel(row);
		if (!model) continue;
		const resolved = resolvePricing("codex", model, row.timestamp * 1_000);
		if (!resolved || resolved.source !== "built-in") continue;
		const factor = PRICE_FACTORS[resolved.model];
		if (factor === undefined) continue;

		// The four token rates and their long-context variants changed by the same
		// factor. Scale the persisted per-query estimate so the repair preserves
		// Hlid's original per-turn and child-agent accounting instead of trying to
		// reconstruct it from aggregate token buckets. Historical rows do not retain
		// enough detail to reproduce that accounting at its original granularity.
		update.run(row.estimated_cost * factor, row.id);
		repaired++;
		if (row.session_id) sessionIds.add(row.session_id);
		if (table === "usage_queries") dates.add(row.local_date);
	}

	return { rows: repaired, sessionIds, dates };
}

export function repairCodexPricingCutover(
	db: Database,
): CodexPricingCutoverRepairResult {
	const queries = repairRows(db, "queries");
	const usageQueries = repairRows(db, "usage_queries");
	const updateSession = db.prepare(`
		UPDATE sessions SET
			total_estimated_cost = COALESCE((
				SELECT SUM(estimated_cost) FROM queries WHERE session_id = ?
			), 0)
		WHERE id = ?
	`);
	for (const sessionId of queries.sessionIds) {
		updateSession.run(sessionId, sessionId);
	}
	for (const date of usageQueries.dates) rebuildUsageDate(db, date);

	return {
		queryRows: queries.rows,
		usageQueryRows: usageQueries.rows,
	};
}
