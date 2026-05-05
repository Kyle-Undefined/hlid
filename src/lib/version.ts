// Single source of truth for the running app version. Imported from
// package.json so a single bumpp/tag bump propagates everywhere (UI footer,
// /api/version, /api/health, update comparator). Bun bundles JSON imports
// at compile time, so the string is baked into the .exe.

import pkg from "../../package.json" with { type: "json" };

export const CURRENT_VERSION: string = pkg.version;
