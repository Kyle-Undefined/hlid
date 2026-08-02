export type InstructionFileProvider = "codex" | "claude";

export type InstructionFileOwner = "vault" | "global" | "agent";

export type InstructionFileEnvironment = "windows" | "wsl" | "host";

export type InstructionFileTarget = {
	id: string;
	owner: InstructionFileOwner;
	provider: InstructionFileProvider;
	filename: "AGENTS.md" | "CLAUDE.md";
	scopeLabel: string;
	environment: InstructionFileEnvironment;
	environmentLabel: string;
	path: string;
	agentPath?: string;
	/** Null until the configured target is opened and inspected. */
	exists: boolean | null;
	size: number | null;
	revision: string | null;
	writable: boolean;
	error?: string;
};

export type InstructionFileDocument = Omit<InstructionFileTarget, "exists"> & {
	exists: boolean;
	content: string;
};
