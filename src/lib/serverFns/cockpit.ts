/** Cockpit dashboard data from the shared server-owned vault snapshot. */
import { createServerFn } from "@tanstack/react-start";

export const getCockpitData = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getVaultSnapshot } = await import("#/server/vaultSnapshot");
		return (await getVaultSnapshot()).cockpit;
	},
);

/** Raven only needs the compact skill inventory, not the full Cockpit snapshot. */
export const getCockpitSkillsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getVaultSnapshot } = await import("#/server/vaultSnapshot");
		return (await getVaultSnapshot()).cockpit.skills;
	},
);
