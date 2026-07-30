import { useCallback, useEffect, useRef, useState } from "react";

export type StagedAgentSkill = {
	id: string;
	name: string;
	description: string;
	sourceUrl: string;
	repository: string;
	requestedRef: string;
	resolvedSha: string;
	repositoryPath: string;
	createdAt: string;
	files: Array<{ path: string; bytes: number; readable: boolean }>;
	fileCount: number;
	bytes: number;
	skillDocument: string;
};

export type StagedSkillInstallWarning = {
	code: "skill_snapshot_refresh_failed";
	message: string;
};

type StageSkill = (input: {
	data: { sourceUrl: string };
}) => Promise<{ ok: true; skill: StagedAgentSkill }>;

type ReadStagedFile = (input: {
	data: { id: string; path: string };
}) => Promise<{ path: string; content: string }>;

type InstallSkill = (input: { data: { id: string } }) => Promise<{
	ok: true;
	installed: { id: string; name: string };
	warning?: StagedSkillInstallWarning;
}>;

type DiscardSkill = (input: { data: { id: string } }) => Promise<{ ok: true }>;

type StagedSkillReviewStatus = "staged" | "failed" | "busy" | "closed";

export function useStagedSkillReview({
	stageSkill,
	readStagedFile,
	installSkill,
	discardSkill,
	onApproved,
	onError,
	onNotice,
	onWarning,
	onClose,
}: {
	stageSkill: StageSkill;
	readStagedFile: ReadStagedFile;
	installSkill: InstallSkill;
	discardSkill: DiscardSkill;
	onApproved?: (message: string) => void | Promise<void>;
	onError: (message: string | null) => void;
	onNotice: (message: string | null) => void;
	onWarning?: (message: string | null) => void;
	onClose: () => void;
}) {
	const [staged, setStaged] = useState<StagedAgentSkill | null>(null);
	const [selectedFile, setSelectedFile] = useState("SKILL.md");
	const [selectedContent, setSelectedContent] = useState("");
	const [busy, setBusy] = useState(false);
	const mountedRef = useRef(true);
	const closedRef = useRef(false);
	const busyRef = useRef(false);
	const stagedRef = useRef<StagedAgentSkill | null>(null);
	const selectedFileRef = useRef("SKILL.md");
	const actionRequestRef = useRef(0);
	const actionKindRef = useRef<"stage" | "approve" | "decline" | null>(null);
	const fileRequestRef = useRef(0);
	const discardRequestsRef = useRef(new Map<string, Promise<void>>());
	const retiredStagesRef = useRef(new Set<string>());
	const discardSkillRef = useRef(discardSkill);
	discardSkillRef.current = discardSkill;

	const canUpdate = useCallback(
		() => mountedRef.current && !closedRef.current,
		[],
	);

	const discardOnce = useCallback(
		(
			skill: StagedAgentSkill,
			{ retryable }: { retryable: boolean },
		): Promise<void> => {
			const existing = discardRequestsRef.current.get(skill.id);
			if (existing) return existing;
			let request: Promise<void>;
			try {
				request = discardSkillRef
					.current({ data: { id: skill.id } })
					.then(() => undefined);
			} catch (cause) {
				request = Promise.reject(cause);
			}
			discardRequestsRef.current.set(skill.id, request);
			void request.catch(() => {
				if (
					retryable &&
					canUpdate() &&
					!retiredStagesRef.current.has(skill.id) &&
					discardRequestsRef.current.get(skill.id) === request
				) {
					discardRequestsRef.current.delete(skill.id);
				}
			});
			return request;
		},
		[canUpdate],
	);

	const clearStaged = useCallback(
		(skill: StagedAgentSkill) => {
			if (stagedRef.current?.id !== skill.id) return;
			stagedRef.current = null;
			selectedFileRef.current = "SKILL.md";
			fileRequestRef.current += 1;
			if (!canUpdate()) return;
			setStaged(null);
			setSelectedFile("SKILL.md");
			setSelectedContent("");
		},
		[canUpdate],
	);

	useEffect(() => {
		mountedRef.current = true;
		closedRef.current = false;
		return () => {
			mountedRef.current = false;
			closedRef.current = true;
			actionRequestRef.current += 1;
			fileRequestRef.current += 1;
			const skill = stagedRef.current;
			if (!skill || retiredStagesRef.current.has(skill.id)) return;
			if (actionKindRef.current === "approve") return;
			retiredStagesRef.current.add(skill.id);
			void discardOnce(skill, { retryable: false }).catch(() => {});
		};
	}, [discardOnce]);

	const stageSource = useCallback(
		async (sourceUrl: string): Promise<StagedSkillReviewStatus> => {
			const source = sourceUrl.trim();
			if (!source || busyRef.current || stagedRef.current) return "busy";
			if (!canUpdate()) return "closed";
			busyRef.current = true;
			actionKindRef.current = "stage";
			setBusy(true);
			onError(null);
			onNotice(null);
			onWarning?.(null);
			const requestId = ++actionRequestRef.current;
			try {
				const result = await stageSkill({ data: { sourceUrl: source } });
				if (
					!canUpdate() ||
					actionRequestRef.current !== requestId ||
					stagedRef.current
				) {
					retiredStagesRef.current.add(result.skill.id);
					await discardOnce(result.skill, { retryable: false }).catch(() => {});
					return "closed";
				}
				stagedRef.current = result.skill;
				selectedFileRef.current = "SKILL.md";
				fileRequestRef.current += 1;
				setStaged(result.skill);
				setSelectedFile("SKILL.md");
				setSelectedContent(result.skill.skillDocument);
				return "staged";
			} catch (cause) {
				if (canUpdate() && actionRequestRef.current === requestId) {
					onError(
						cause instanceof Error ? cause.message : "Unable to stage skill",
					);
				}
				return canUpdate() ? "failed" : "closed";
			} finally {
				if (actionRequestRef.current === requestId) {
					actionKindRef.current = null;
					busyRef.current = false;
					if (canUpdate()) setBusy(false);
				}
			}
		},
		[canUpdate, discardOnce, onError, onNotice, onWarning, stageSkill],
	);

	const selectFile = useCallback(
		async (path: string): Promise<void> => {
			const skill = stagedRef.current;
			if (!skill || !canUpdate() || path === selectedFileRef.current) return;
			const file = skill.files.find((candidate) => candidate.path === path);
			if (!file?.readable) return;
			const requestId = ++fileRequestRef.current;
			selectedFileRef.current = path;
			setSelectedFile(path);
			onError(null);
			if (path === "SKILL.md") {
				setSelectedContent(skill.skillDocument);
				return;
			}
			setSelectedContent("Loading…");
			try {
				const result = await readStagedFile({
					data: { id: skill.id, path },
				});
				if (
					!canUpdate() ||
					fileRequestRef.current !== requestId ||
					stagedRef.current?.id !== skill.id ||
					selectedFileRef.current !== path
				) {
					return;
				}
				setSelectedContent(result.content);
			} catch (cause) {
				if (
					!canUpdate() ||
					fileRequestRef.current !== requestId ||
					stagedRef.current?.id !== skill.id ||
					selectedFileRef.current !== path
				) {
					return;
				}
				setSelectedContent("");
				onError(cause instanceof Error ? cause.message : "Unable to read file");
			}
		},
		[canUpdate, onError, readStagedFile],
	);

	const approve = useCallback(async (): Promise<void> => {
		const skill = stagedRef.current;
		if (!skill || busyRef.current || !canUpdate()) return;
		busyRef.current = true;
		actionKindRef.current = "approve";
		setBusy(true);
		onError(null);
		onWarning?.(null);
		fileRequestRef.current += 1;
		const requestId = ++actionRequestRef.current;
		try {
			const { installed, warning } = await installSkill({
				data: { id: skill.id },
			});
			retiredStagesRef.current.add(skill.id);
			clearStaged(skill);
			if (!canUpdate() || actionRequestRef.current !== requestId) return;
			const summary = `${installed.name} added to Hlid`;
			onNotice(summary);
			if (warning) {
				onWarning?.(`Skill list refresh is delayed: ${warning.message}`);
			}
			try {
				await onApproved?.(summary);
			} catch (cause) {
				console.error("Staged skill approval callback failed", cause);
			}
		} catch (cause) {
			if (canUpdate() && actionRequestRef.current === requestId) {
				onError(cause instanceof Error ? cause.message : "Unable to add skill");
			} else {
				retiredStagesRef.current.add(skill.id);
				await discardOnce(skill, { retryable: false }).catch(() => {});
			}
			return;
		} finally {
			if (actionRequestRef.current === requestId) {
				actionKindRef.current = null;
				busyRef.current = false;
				if (canUpdate()) setBusy(false);
			}
		}
	}, [
		canUpdate,
		clearStaged,
		discardOnce,
		installSkill,
		onApproved,
		onError,
		onNotice,
		onWarning,
	]);

	const decline = useCallback(async (): Promise<void> => {
		const skill = stagedRef.current;
		if (!skill || busyRef.current || !canUpdate()) return;
		busyRef.current = true;
		actionKindRef.current = "decline";
		setBusy(true);
		onError(null);
		fileRequestRef.current += 1;
		const requestId = ++actionRequestRef.current;
		try {
			await discardOnce(skill, { retryable: true });
			retiredStagesRef.current.add(skill.id);
			clearStaged(skill);
			if (canUpdate() && actionRequestRef.current === requestId) {
				onNotice(`${skill.name} declined`);
			}
		} catch (cause) {
			if (canUpdate() && actionRequestRef.current === requestId) {
				onError(
					cause instanceof Error ? cause.message : "Unable to decline skill",
				);
			}
		} finally {
			if (actionRequestRef.current === requestId) {
				actionKindRef.current = null;
				busyRef.current = false;
				if (canUpdate()) setBusy(false);
			}
		}
	}, [canUpdate, clearStaged, discardOnce, onError, onNotice]);

	const close = useCallback(() => {
		if (busyRef.current || closedRef.current) return;
		busyRef.current = true;
		if (mountedRef.current) setBusy(true);
		closedRef.current = true;
		actionRequestRef.current += 1;
		fileRequestRef.current += 1;
		const skill = stagedRef.current;
		if (skill) retiredStagesRef.current.add(skill.id);
		void (async () => {
			if (skill) {
				await discardOnce(skill, { retryable: false }).catch(() => {});
			}
			onClose();
		})();
	}, [discardOnce, onClose]);

	return {
		staged,
		selectedFile,
		selectedContent,
		busy,
		stageSource,
		selectFile,
		approve,
		decline,
		close,
	};
}
