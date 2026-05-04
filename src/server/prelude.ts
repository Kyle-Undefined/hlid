// Must be the FIRST import in index.ts. Compiled exe only.
// Any write to stdout/stderr before our console.* redirect triggers Bun's
// AllocConsole(), which creates a visible (blank) console window. Patch
// both write methods to no-ops here — this module has no local imports so
// it executes before any third-party module can write during initialization.
if (process.execPath.endsWith(".exe")) {
	(process.stdout as unknown as { write: () => boolean }).write = () => true;
	(process.stderr as unknown as { write: () => boolean }).write = () => true;
}
