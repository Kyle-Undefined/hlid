type PtyAssets = {
	workerCjs: string;
	packageJson: string;
	natives: Record<string, string>;
	lib: Record<string, string>;
};

// Development stub. scripts/build-win.ts redirects this module to generated
// embedded assets while compiling the Windows executable.
export const PTY_ASSETS: PtyAssets | null = null;
export const PTY_ASSETS_HASH = "dev";
