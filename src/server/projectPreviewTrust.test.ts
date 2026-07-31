import { describe, expect, it } from "vitest";
import {
	createProjectPreviewCapability,
	isTrustedProjectPreviewRequest,
	PROJECT_PREVIEW_AUTH_ENV,
	PROJECT_PREVIEW_AUTH_HEADER,
	projectPreviewCapabilityHeaders,
} from "./projectPreviewTrust";

describe("Project Preview child authentication", () => {
	it("creates fresh high-entropy capabilities and exposes only the relay header", () => {
		const first = createProjectPreviewCapability();
		const second = createProjectPreviewCapability();

		expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second.token).not.toBe(first.token);
		expect(projectPreviewCapabilityHeaders(first)).toEqual({
			[PROJECT_PREVIEW_AUTH_HEADER]: first.token,
		});
	});

	it("accepts only the exact configured child capability", () => {
		const capability = { token: "preview-auth-test-token" };
		const environment = {
			[PROJECT_PREVIEW_AUTH_ENV]: capability.token,
		};
		const trusted = new Request("http://127.0.0.1:5173", {
			headers: projectPreviewCapabilityHeaders(capability),
		});

		expect(isTrustedProjectPreviewRequest(trusted, environment)).toBe(true);
		expect(
			isTrustedProjectPreviewRequest(
				new Request("http://127.0.0.1:5173", {
					headers: { [PROJECT_PREVIEW_AUTH_HEADER]: "wrong" },
				}),
				environment,
			),
		).toBe(false);
		expect(
			isTrustedProjectPreviewRequest(
				new Request("http://127.0.0.1:5173"),
				environment,
			),
		).toBe(false);
		expect(isTrustedProjectPreviewRequest(trusted, {})).toBe(false);
		expect(
			isTrustedProjectPreviewRequest(trusted, {
				[PROJECT_PREVIEW_AUTH_ENV]: "x".repeat(257),
			}),
		).toBe(false);
	});
});
