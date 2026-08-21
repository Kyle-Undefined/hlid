import { z } from "zod";

export const LOCAL_AI_SETUP_SETTING_KEY = "local_ai_setup_v1";

export const LocalAiSetupStepIdSchema = z.enum([
	"ollama",
	"opencode",
	"models",
	"wsl-access",
]);

export type LocalAiSetupStepId = z.infer<typeof LocalAiSetupStepIdSchema>;

/**
 * This is deliberately limited to user workflow intent. It is not a record of
 * installations, credentials, firewall changes, or model lifecycle state.
 */
export const LocalAiSetupIntentSchema = z
	.object({
		version: z.literal(1),
		startedAt: z.number().int().nonnegative(),
		acknowledged: z.array(LocalAiSetupStepIdSchema).max(4),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((value, context) => {
		if (new Set(value.acknowledged).size !== value.acknowledged.length) {
			context.addIssue({
				code: "custom",
				path: ["acknowledged"],
				message: "Acknowledged steps must be unique",
			});
		}
	});

export type LocalAiSetupIntent = z.infer<typeof LocalAiSetupIntentSchema>;

export type LocalAiSetupStep = {
	id: LocalAiSetupStepId;
	title: string;
	description: string;
	status: "ready" | "needs-action" | "not-needed" | "unknown";
	acknowledged: boolean;
	action: "ollama" | "opencode" | null;
};

export type LocalAiSetupSnapshot = {
	intent: LocalAiSetupIntent | null;
	live: {
		ollama: {
			supported: boolean;
			available: boolean | null;
			setupPhase: string | null;
		};
		openCode: {
			configured: boolean;
			available: boolean | null;
			target: "windows" | "wsl" | null;
		};
		models: { selected: string[]; present: string[] | null };
		wslAccessRequired: boolean;
		firewallReady: boolean | null;
	};
	steps: LocalAiSetupStep[];
};

export const LocalAiSetupMutationSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("start") }).strict(),
	z
		.object({
			action: z.literal("acknowledge"),
			step: LocalAiSetupStepIdSchema,
		})
		.strict(),
]);

export type LocalAiSetupMutation = z.infer<typeof LocalAiSetupMutationSchema>;
