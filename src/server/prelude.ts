// Must be the FIRST import in index.ts. Compiled exe only.
// Any write to stdout/stderr before our console.* redirect triggers Bun's
// AllocConsole(), which creates a visible (blank) console window. Patch
// both write methods to no-ops here, before any third-party module gets a
// chance to write during initialization.
//
// Also runs the self-install check: if a versioned exe was launched, copy
// it to the canonical %LOCALAPPDATA%\Hlid\hlid.exe path and relaunch. Done
// here (top of execution) so we never open the DB or touch other state
// from a non-canonical execPath.
import { maybeSelfInstall } from "../lib/install";

if (process.execPath.endsWith(".exe")) {
	(process.stdout as unknown as { write: () => boolean }).write = () => true;
	(process.stderr as unknown as { write: () => boolean }).write = () => true;
	await maybeSelfInstall();
}
