import type {
	AcpManagedMutationRequest,
	AcpManagedOperationSnapshot,
} from "./acpManagedTypes";

export async function mutateAcpManagedInstallation(
	input: AcpManagedMutationRequest,
): Promise<AcpManagedOperationSnapshot> {
	const response = await fetch("/api/acp/installations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean;
		data?: AcpManagedOperationSnapshot;
		error?: string;
	} | null;
	if (!response.ok || !payload?.ok || !payload.data) {
		throw new Error(
			payload?.error || `ACP installation failed (${response.status})`,
		);
	}
	return payload.data;
}
