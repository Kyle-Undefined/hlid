import { randomBytes } from "node:crypto";
import { verifyToken } from "../lib/token";

export const PROJECT_PREVIEW_AUTH_ENV =
	"HLID_PROJECT_PREVIEW_AUTH_TOKEN" as const;
export const PROJECT_PREVIEW_AUTH_HEADER =
	"x-hlid-project-preview-auth" as const;

export type ProjectPreviewCapability = Readonly<{
	token: string;
}>;

export function createProjectPreviewCapability(): ProjectPreviewCapability {
	return { token: randomBytes(32).toString("base64url") };
}

export function projectPreviewCapabilityHeaders(
	capability: ProjectPreviewCapability,
): Record<string, string> {
	return { [PROJECT_PREVIEW_AUTH_HEADER]: capability.token };
}

export function isTrustedProjectPreviewRequest(
	request: Request,
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	const expected = environment[PROJECT_PREVIEW_AUTH_ENV];
	if (!expected || expected.length > 256) return false;
	return verifyToken(
		request.headers.get(PROJECT_PREVIEW_AUTH_HEADER),
		expected,
	);
}
