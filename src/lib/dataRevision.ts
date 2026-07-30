export const DATA_DOMAINS = [
	"stats",
	"sessions",
	"relics",
	"vault",
	"providers",
	"config",
	"mcp",
	"storage",
	"routines",
	"umbod",
] as const;

export type DataDomain = (typeof DATA_DOMAINS)[number];
export type DataRevisionSnapshot = Record<DataDomain, number>;
