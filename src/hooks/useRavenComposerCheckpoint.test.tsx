// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	RelicReferenceItem,
	VaultReferenceItem,
	WorkspaceReferenceSelection,
} from "#/lib/vaultReferences";
import type { ChatAttachment } from "#/server/protocol";
import {
	loadRavenComposerCheckpoint,
	type RavenComposerCheckpointData,
	ravenComposerCheckpointStorageKey,
	saveRavenComposerCheckpoint,
	useRavenComposerCheckpoint,
} from "./useRavenComposerCheckpoint";
import type { VaultReferenceSelections } from "./useVaultReferencePicker";

const attachment: ChatAttachment = {
	id: "attachment-1",
	path: "/server/attachments/attachment-1",
	filename: "notes.txt",
	mime: "text/plain",
	kind: "ephemeral",
};

const vaultReference: VaultReferenceItem = {
	relativePath: "Projects/Hlid.md",
	name: "Hlid.md",
	directory: "Projects",
};

const relicReference: RelicReferenceItem = {
	id: "relic-1",
	path: "/vault/.hlid/report.pdf",
	filename: "report.pdf",
	mime: "application/pdf",
	kind: "vault",
	createdAt: 123,
	category: "report",
};

const workspaceReference: WorkspaceReferenceSelection = {
	relativePath: "src/server/session.ts",
	name: "session.ts",
	directory: "src/server",
	sha256: "a".repeat(64),
	sizeBytes: 23,
	environment: "wsl",
	environmentLabel: "WSL · Ubuntu",
	previewKind: "text",
	mime: "text/plain",
};

function checkpointData(
	overrides: Partial<RavenComposerCheckpointData> = {},
): RavenComposerCheckpointData {
	return {
		attachments: [attachment],
		vaultReferences: [vaultReference],
		relicReferences: [relicReference],
		workspaceReferences: [workspaceReference],
		...overrides,
	};
}

function useCheckpointHarness(draftKey: string) {
	const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
	const [vaultReferences, setVaultReferences] = useState<VaultReferenceItem[]>(
		[],
	);
	const [relicReferences, setRelicReferences] = useState<RelicReferenceItem[]>(
		[],
	);
	const [workspaceReferences, setWorkspaceReferences] = useState<
		WorkspaceReferenceSelection[]
	>([]);
	const replaceReferences = useCallback(
		({ vault, relics, workspace }: VaultReferenceSelections) => {
			setVaultReferences(vault);
			setRelicReferences(relics);
			setWorkspaceReferences(workspace);
		},
		[],
	);
	const checkpoint = useRavenComposerCheckpoint({
		draftKey,
		attachments,
		setAttachments,
		vaultReferences,
		relicReferences,
		workspaceReferences,
		replaceReferences,
	});
	return {
		attachments,
		setAttachments,
		vaultReferences,
		relicReferences,
		workspaceReferences,
		replaceReferences,
		checkpoint,
	};
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Raven composer checkpoints", () => {
	it("stores only the bounded metadata allowlist", () => {
		const draftKey = "hlid:draft:watch";
		const unsafeInput = {
			...checkpointData(),
			attachments: [
				{ ...attachment, rawBlob: new Blob(["private bytes"]) },
				{ ...attachment, id: "relic-attachment", reference: "relic" },
			],
			prompt: "do not duplicate this prompt",
			skills: ["secret-skill"],
			secret: "do not persist me",
		} as unknown as RavenComposerCheckpointData;

		expect(saveRavenComposerCheckpoint(draftKey, unsafeInput)).toBe(true);
		const key = ravenComposerCheckpointStorageKey(draftKey);
		if (!key) throw new Error("missing checkpoint key");
		const serialized = localStorage.getItem(key) ?? "";
		expect(serialized).toContain('"version":1');
		expect(serialized).not.toContain("rawBlob");
		expect(serialized).not.toContain("private bytes");
		expect(serialized).not.toContain("do not duplicate this prompt");
		expect(serialized).not.toContain("secret-skill");
		expect(serialized).not.toContain("do not persist me");
		expect(loadRavenComposerCheckpoint(draftKey)?.attachments).toEqual([
			attachment,
		]);
	});

	it("rejects unknown fields, excessive counts, and oversized values", () => {
		const draftKey = "hlid:draft:watch";
		const key = ravenComposerCheckpointStorageKey(draftKey);
		if (!key) throw new Error("missing checkpoint key");
		localStorage.setItem(
			key,
			JSON.stringify({
				version: 1,
				attachments: [],
				vaultReferences: [],
				relicReferences: [],
				workspaceReferences: [],
				prompt: "unexpected",
			}),
		);
		expect(loadRavenComposerCheckpoint(draftKey)).toBeNull();
		expect(localStorage.getItem(key)).toBeNull();

		expect(
			saveRavenComposerCheckpoint(
				draftKey,
				checkpointData({
					attachments: Array.from({ length: 33 }, (_, index) => ({
						...attachment,
						id: `attachment-${index}`,
					})),
				}),
			),
		).toBe(false);
		expect(
			saveRavenComposerCheckpoint(
				draftKey,
				checkpointData({
					vaultReferences: [
						{ ...vaultReference, relativePath: "x".repeat(4_097) },
					],
				}),
			),
		).toBe(false);
	});

	it("restores once per draft-key change and replaces every selection", async () => {
		const watch = "hlid:draft:watch";
		const other = "hlid:draft:other";
		saveRavenComposerCheckpoint(watch, checkpointData());
		saveRavenComposerCheckpoint(
			other,
			checkpointData({
				attachments: [],
				vaultReferences: [
					{
						relativePath: "Inbox/Todo.md",
						name: "Todo.md",
						directory: "Inbox",
					},
				],
				relicReferences: [],
				workspaceReferences: [],
			}),
		);
		const { result, rerender } = renderHook(
			({ draftKey }) => useCheckpointHarness(draftKey),
			{ initialProps: { draftKey: watch } },
		);
		await waitFor(() =>
			expect(result.current.attachments).toEqual([attachment]),
		);
		expect(result.current.relicReferences).toEqual([relicReference]);
		expect(result.current.workspaceReferences).toEqual([workspaceReference]);

		rerender({ draftKey: other });
		await waitFor(() =>
			expect(result.current.vaultReferences).toEqual([
				{
					relativePath: "Inbox/Todo.md",
					name: "Todo.md",
					directory: "Inbox",
				},
			]),
		);
		expect(result.current.attachments).toEqual([]);
		expect(result.current.relicReferences).toEqual([]);
		expect(result.current.workspaceReferences).toEqual([]);
	});

	it("clears storage, pending attachments, and all references together", async () => {
		const draftKey = "hlid:draft:watch";
		saveRavenComposerCheckpoint(draftKey, checkpointData());
		const { result } = renderHook(() => useCheckpointHarness(draftKey));
		await waitFor(() =>
			expect(result.current.attachments).toEqual([attachment]),
		);

		act(() => result.current.checkpoint.clear());

		expect(loadRavenComposerCheckpoint(draftKey)).toBeNull();
		expect(result.current.attachments).toEqual([]);
		expect(result.current.vaultReferences).toEqual([]);
		expect(result.current.relicReferences).toEqual([]);
		expect(result.current.workspaceReferences).toEqual([]);
	});
});
