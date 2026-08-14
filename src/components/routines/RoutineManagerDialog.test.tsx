// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "#/lib/providerTypes";
import type { RoutineDefinition, RoutineSummary } from "#/lib/routines";
import type { Skill } from "#/lib/skills";
import {
	RoutineManagerDialog,
	type RoutineTarget,
} from "./RoutineManagerDialog";

const serverFns = vi.hoisted(() => ({
	archiveRoutineFn: vi.fn(),
	createRoutineFn: vi.fn(),
	getRoutineRunFn: vi.fn(),
	getRoutineRunsFn: vi.fn(),
	previewRoutineScheduleFn: vi.fn().mockResolvedValue([]),
	runRoutineNowFn: vi.fn(),
	setRoutineEnabledFn: vi.fn(),
	updateRoutineFn: vi.fn(),
}));
const vaultFns = vi.hoisted(() => ({
	searchVaultReferencesFn: vi.fn().mockResolvedValue({
		rootLabel: "Fornbok",
		items: [
			{
				relativePath: "Reports/Weekly.md",
				name: "Weekly.md",
				directory: "Reports",
			},
		],
		total: 1,
		truncated: false,
	}),
	searchRelicReferencesFn: vi.fn().mockResolvedValue({
		items: [
			{
				id: "11111111-1111-4111-8111-111111111111",
				path: "C:/Hlid/library/report.pdf",
				filename: "report.pdf",
				mime: "application/pdf",
				kind: "vault",
				createdAt: 1_753_185_600,
				category: "report",
			},
		],
		total: 1,
		truncated: false,
	}),
}));
const pushFns = vi.hoisted(() => ({
	getPushNotificationDevices: vi.fn().mockResolvedValue([]),
}));

vi.mock("#/lib/serverFns/routines", () => serverFns);
vi.mock("#/lib/serverFns/vaultReferences", () => vaultFns);
vi.mock("#/lib/pushNotifications", () => pushFns);

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	serverFns.previewRoutineScheduleFn.mockResolvedValue([]);
	serverFns.getRoutineRunFn.mockResolvedValue(null);
	pushFns.getPushNotificationDevices.mockResolvedValue([]);
});

const targets: RoutineTarget[] = [
	{
		path: "C:/Vault",
		name: "Fornbok",
		providerId: "codex",
		model: "gpt-5.4",
		effort: "medium",
	},
	{
		path: "C:/Projects/Hlid",
		name: "Hlid",
		providerId: "claude",
		model: "claude-opus-4-6",
		effort: "high",
	},
];

const providers: ProviderInfo[] = [
	{
		id: "codex",
		label: "Codex",
		available: true,
		models: [
			{
				value: "gpt-5.4",
				label: "GPT-5.4",
				isDefault: true,
				efforts: [{ value: "medium", label: "Medium", isDefault: true }],
			},
		],
	},
	{
		id: "claude",
		label: "Claude",
		available: true,
		models: [
			{
				value: "claude-opus-4-6",
				label: "Claude Opus 4.6",
				isDefault: true,
				efforts: [{ value: "high", label: "High", isDefault: true }],
			},
		],
	},
];

const skills: Skill[] = [
	{
		file: "review.md",
		filePath: "C:/Vault/Skills/review.md",
		name: "Vault Review",
		description: "Review work using the vault workflow",
		content: "Review carefully",
		source: "vault",
	},
	{
		file: "audit/SKILL.md",
		filePath: "C:/Hlid/skills/audit/SKILL.md",
		name: "AAA Hlid Audit",
		description: "Audit work using a Hlid-managed skill",
		content: "Audit carefully",
		source: "hlid",
	},
	{
		file: "research/SKILL.md",
		filePath: "C:/Users/kyle/.claude/skills/research/SKILL.md",
		name: "Claude Research",
		description: "Use Claude's native research workflow",
		content: "Research carefully",
		providerId: "claude",
		source: "provider",
	},
];

const defaultDefinition: RoutineDefinition = {
	name: "New Routine",
	prompt: "",
	enabled: false,
	schedule: { kind: "daily", time: "09:00" },
	timezone: "America/New_York",
	providerId: "codex",
	model: "gpt-5.4",
	effort: "medium",
	agentCwd: "C:/Vault",
	agentName: "Fornbok",
	skillContexts: [],
	providerCommands: [],
	vaultReferences: [],
	relicIds: [],
	permissionMode: "read_only",
	grants: [],
	deliveries: [],
	notificationPolicy: {
		success: "default",
		actionRequired: "default",
		failure: "default",
		targets: { kind: "all" },
	},
	catchUpWindowMinutes: 360,
	noOverlap: true,
};

const notificationRoutine: RoutineSummary = {
	...defaultDefinition,
	id: "11111111-1111-4111-8111-111111111111",
	name: "Daily review",
	enabled: true,
	archived: false,
	revision: 1,
	nextRunAt: null,
	pausedReason: null,
	authorizationFingerprint: "fingerprint",
	createdAt: 1_786_550_400,
	updatedAt: 1_786_550_400,
	lastRun: null,
};

const archivedNotificationRoutine: RoutineSummary = {
	...notificationRoutine,
	enabled: false,
	archived: true,
	nextRunAt: null,
};

function notificationDevice(index: number) {
	const id = `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
	return {
		id,
		name: `Device ${index}`,
		current: index === 1,
		enabled: true,
		createdAt: 1_786_550_400,
		lastSeenAt: 1_786_550_400,
		pausedUntil: null,
		pausedIndefinitely: false,
		preferences: {
			requests: true,
			problems: true,
			workFinished: false,
			detail: "generic" as const,
			completionMinimumMinutes: 0 as const,
			quietHours: null,
		},
		lastAcceptedAt: null,
		lastFailureAt: null,
		lastFailureMessage: null,
		failureCount: 0,
	};
}

describe("RoutineManagerDialog", () => {
	it("opens and highlights the exact run selected by a notification", async () => {
		const runId = "22222222-2222-4222-8222-222222222222";
		serverFns.getRoutineRunsFn.mockResolvedValue([
			{
				id: runId,
				routine_id: notificationRoutine.id,
				routine_revision: 1,
				profile_id: null,
				authorization_fingerprint: "fingerprint",
				trigger: "scheduled",
				scheduled_for: 1_786_550_400,
				claimed_at: 1_786_550_400,
				lease_owner: null,
				lease_expires_at: null,
				started_at: 1_786_550_401,
				finished_at: 1_786_550_410,
				status: "action_required",
				session_id: "session-1",
				provider_used: "codex",
				error: null,
				action_required: "Approve filesystem access",
				delivery_json: null,
				created_at: 1_786_550_400,
			},
		]);
		render(
			<RoutineManagerDialog
				routines={[notificationRoutine]}
				initialRoutineId={notificationRoutine.id}
				initialRunId={runId}
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(screen.getByText("Opened from notification")).toBeDefined();
		await waitFor(() =>
			expect(serverFns.getRoutineRunsFn).toHaveBeenCalledWith({
				data: { id: notificationRoutine.id, limit: 200 },
			}),
		);
		expect(serverFns.getRoutineRunFn).toHaveBeenCalledWith({
			data: { routineId: notificationRoutine.id, runId },
		});
		const selected = await screen.findByText("action_required");
		expect(selected.closest('[aria-current="true"]')).not.toBeNull();
	});

	it("opens an archived Routine read-only and highlights its notified run", async () => {
		const runId = "33333333-3333-4333-8333-333333333333";
		serverFns.getRoutineRunsFn.mockResolvedValue([
			{
				id: runId,
				routine_id: archivedNotificationRoutine.id,
				routine_revision: 1,
				profile_id: null,
				authorization_fingerprint: "fingerprint",
				trigger: "scheduled",
				scheduled_for: 1_786_550_400,
				claimed_at: 1_786_550_400,
				lease_owner: null,
				lease_expires_at: null,
				started_at: 1_786_550_401,
				finished_at: 1_786_550_410,
				status: "succeeded",
				session_id: "session-archived",
				provider_used: "codex",
				error: null,
				action_required: null,
				delivery_json: null,
				created_at: 1_786_550_400,
			},
		]);
		render(
			<RoutineManagerDialog
				routines={[archivedNotificationRoutine]}
				initialRoutineId={archivedNotificationRoutine.id}
				initialRunId={runId}
				notificationTargetStatus="ready"
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(screen.getByText("Archived Routine")).toBeTruthy();
		expect(
			screen.getByText(
				"This archived Routine is read-only. Its notified run remains available in history.",
			),
		).toBeTruthy();
		expect(screen.queryByTitle("Run now")).toBeNull();
		expect(screen.queryByTitle("Archive")).toBeNull();
		const selected = await screen.findByText("succeeded");
		expect(selected.closest('[aria-current="true"]')).not.toBeNull();
		expect(serverFns.getRoutineRunsFn).toHaveBeenCalledWith({
			data: { id: archivedNotificationRoutine.id, limit: 200 },
		});
		expect(serverFns.getRoutineRunFn).toHaveBeenCalledWith({
			data: { routineId: archivedNotificationRoutine.id, runId },
		});
	});

	it("merges an exact notified run that fell outside recent history", async () => {
		const runId = "55555555-5555-4555-8555-555555555555";
		serverFns.getRoutineRunsFn.mockResolvedValue([]);
		serverFns.getRoutineRunFn.mockResolvedValue({
			id: runId,
			routine_id: notificationRoutine.id,
			routine_revision: 1,
			profile_id: null,
			authorization_fingerprint: "fingerprint",
			trigger: "scheduled",
			scheduled_for: 1_786_000_000,
			claimed_at: 1_786_000_000,
			lease_owner: null,
			lease_expires_at: null,
			started_at: 1_786_000_001,
			finished_at: 1_786_000_010,
			status: "succeeded",
			session_id: "session-old",
			provider_used: "codex",
			error: null,
			action_required: null,
			delivery_json: null,
			notification_policy_json: null,
			created_at: 1_786_000_000,
		});

		render(
			<RoutineManagerDialog
				routines={[notificationRoutine]}
				initialRoutineId={notificationRoutine.id}
				initialRunId={runId}
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const selected = await screen.findByText("succeeded");
		expect(selected.closest('[aria-current="true"]')).not.toBeNull();
		expect(
			screen.queryByText(/notified run is no longer available/i),
		).toBeNull();
	});

	it("shows an explicit fallback when a notified Routine is unavailable", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialRoutineId={notificationRoutine.id}
				initialRunId="44444444-4444-4444-8444-444444444444"
				notificationTargetStatus="unavailable"
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(
			screen.getByText(/The Routine from this notification is unavailable/),
		).toBeTruthy();
		expect(screen.queryByText(/No Routines configured/)).toBeNull();
		expect(serverFns.getRoutineRunsFn).not.toHaveBeenCalled();
	});

	it("uses backdrop dismissal with the same editor-to-overview close semantics", () => {
		const onClose = vi.fn();
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={onClose}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const dialog = screen.getByRole("dialog", { name: "Routines" });
		const backdrop = dialog.parentElement as HTMLElement;
		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(backdrop);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "New Routine" })).toBeDefined();

		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("returns from the editor to the Routines overview before closing", () => {
		const onClose = vi.fn();
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={onClose}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "New Routine" })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Close Routines" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("opens the overview before creating from Watch", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={null}
				watchDefinition={{
					...defaultDefinition,
					prompt: "Seeded from Watch",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		expect(screen.getByRole("button", { name: "New Routine" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "New from Watch" }));
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
			"Seeded from Watch",
		);
	});

	it("creates an independent Routine and applies workspace harness defaults", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={null}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /New Routine/i }));
		const workspace = screen.getByLabelText("Workspace");
		const harness = screen.getByLabelText("Harness");
		const model = screen.getByLabelText("Model");
		const effort = screen.getByLabelText("Effort");

		expect((workspace as HTMLSelectElement).value).toBe("C:/Vault");
		expect((harness as HTMLSelectElement).value).toBe("codex");
		expect((model as HTMLSelectElement).value).toBe("gpt-5.4");
		expect((effort as HTMLSelectElement).value).toBe("medium");

		fireEvent.change(workspace, { target: { value: "C:/Projects/Hlid" } });
		expect((harness as HTMLSelectElement).value).toBe("claude");
		expect((model as HTMLSelectElement).value).toBe("claude-opus-4-6");
		expect((effort as HTMLSelectElement).value).toBe("high");
	});

	it("keeps model and effort editable when provider discovery is unavailable", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={[]}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const model = screen.getByLabelText("Model");
		const effort = screen.getByLabelText("Effort");
		expect(model.tagName).toBe("INPUT");
		expect(effort.tagName).toBe("INPUT");
		fireEvent.change(model, { target: { value: "custom-model" } });
		fireEvent.change(effort, { target: { value: "custom-effort" } });
		expect((model as HTMLInputElement).value).toBe("custom-model");
		expect((effort as HTMLInputElement).value).toBe("custom-effort");
	});

	it("selects an exact delivery note from the vault", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					prompt: "Write the weekly report",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Exact vault note"));
		fireEvent.click(screen.getByRole("button", { name: "Choose note" }));
		expect(await screen.findByLabelText("Search vault notes")).toBeDefined();
		await waitFor(() =>
			expect(vaultFns.searchVaultReferencesFn).toHaveBeenCalledWith({
				data: { query: "", limit: 40, notesOnly: true },
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Select Reports/Weekly.md",
			}),
		);
		expect(screen.getByTitle("Reports/Weekly.md").textContent).toContain(
			"Reports/Weekly.md",
		);

		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));
		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					deliveries: [{ kind: "note_append", path: "Reports/Weekly.md" }],
				}),
			}),
		);
	});

	it("selects durable context and provider-native skills", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={defaultDefinition}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByLabelText(/Vault Review/));
		fireEvent.change(screen.getByLabelText("Workspace"), {
			target: { value: "C:/Projects/Hlid" },
		});
		fireEvent.click(screen.getByLabelText(/Claude Research/));
		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));

		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					skillContexts: ["C:/Vault/Skills/review.md"],
					providerCommands: ["Claude Research"],
				}),
			}),
		);
	});

	it("edits outcome policies and exact notification device targets", async () => {
		const devices = [notificationDevice(1), notificationDevice(2)];
		pushFns.getPushNotificationDevices.mockResolvedValue(devices);
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					prompt: "Send the daily report",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const success = screen.getByLabelText("Success notifications");
		const action = screen.getByLabelText("Action required notifications");
		const failure = screen.getByLabelText("Failure notifications");
		expect((success as HTMLSelectElement).value).toBe("default");
		expect((action as HTMLSelectElement).value).toBe("default");
		expect((failure as HTMLSelectElement).value).toBe("default");

		fireEvent.change(success, { target: { value: "notify" } });
		fireEvent.change(action, { target: { value: "mute" } });
		fireEvent.change(failure, { target: { value: "notify" } });
		fireEvent.change(screen.getByLabelText("Routine notification targets"), {
			target: { value: "devices" },
		});
		const create = screen.getByRole("button", { name: "Create Routine" });
		expect((create as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Device 1 (this device)" }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Device 2" }));
		expect((create as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(create);

		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					notificationPolicy: {
						success: "notify",
						actionRequired: "mute",
						failure: "notify",
						targets: {
							kind: "devices",
							deviceIds: devices.map((device) => device.id),
						},
					},
				}),
			}),
		);
	});

	it("rejects more than 32 exact devices without silently truncating targets", async () => {
		const devices = Array.from({ length: 33 }, (_, index) =>
			notificationDevice(index + 1),
		);
		pushFns.getPushNotificationDevices.mockResolvedValue(devices);
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					prompt: "Send the daily report",
					notificationPolicy: {
						...defaultDefinition.notificationPolicy,
						targets: {
							kind: "devices",
							deviceIds: devices.map((device) => device.id),
						},
					},
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const thirtyThird = await screen.findByRole("checkbox", {
			name: "Device 33",
		});
		expect((thirtyThird as HTMLInputElement).checked).toBe(true);
		expect(
			screen.getByText("Choose no more than 32 exact notification devices."),
		).toBeTruthy();
		const create = screen.getByRole("button", { name: "Create Routine" });
		expect((create as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(thirtyThird);
		expect((create as HTMLButtonElement).disabled).toBe(false);
	});

	it("orders skills as Vault, Hlid, then the selected provider", () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{
					...defaultDefinition,
					providerId: "claude",
					model: "claude-opus-4-6",
					effort: "high",
					agentCwd: "C:/Projects/Hlid",
					agentName: "Hlid",
				}}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		const vault = screen.getByText("Vault Review");
		const hlid = screen.getByText("AAA Hlid Audit");
		const provider = screen.getByText("Claude Research");
		expect(
			vault.compareDocumentPosition(hlid) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			hlid.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("selects exact vault and retained Relic inputs", async () => {
		render(
			<RoutineManagerDialog
				routines={[]}
				initialDefinition={{ ...defaultDefinition, prompt: "Compare inputs" }}
				defaultDefinition={defaultDefinition}
				targets={targets}
				providers={providers}
				skills={skills}
				commands={[]}
				onClose={vi.fn()}
				onRefresh={vi.fn().mockResolvedValue(undefined)}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Add inputs" }));
		expect(await screen.findByLabelText("Search Routine inputs")).toBeDefined();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Add vault input Reports/Weekly.md",
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Add Relic input report.pdf",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));

		await waitFor(() =>
			expect(serverFns.createRoutineFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					vaultReferences: ["Reports/Weekly.md"],
					relicIds: ["11111111-1111-4111-8111-111111111111"],
				}),
			}),
		);
	});
});
