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
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";

if (process.execPath.endsWith(".exe")) {
	(process.stdout as unknown as { write: () => boolean }).write = () => true;
	(process.stderr as unknown as { write: () => boolean }).write = () => true;

	// Write crashes to a plain file so we can diagnose silent exits in the
	// compiled exe (before the DB logger is initialised).
	const crashLog = `${dirname(process.execPath)}\\crash.log`;
	const stamp = () => new Date().toISOString();
	const writeCrash = (kind: string, detail: unknown) => {
		try {
			appendFileSync(
				crashLog,
				`${stamp()} ${kind} argv=${process.argv.join(" ")}\n${
					detail instanceof Error
						? (detail.stack ?? detail.message)
						: String(detail)
				}\n\n`,
			);
		} catch {}
	};
	process.on("uncaughtException", (err) => {
		writeCrash("uncaughtException", err);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		writeCrash("unhandledRejection", reason);
		process.exit(1);
	});

	try {
		if (process.env.HLID_SKIP_SELF_INSTALL !== "1") {
			const [{ maybeSelfInstall }, { cleanupStagingDir }] = await Promise.all([
				import("../lib/install"),
				import("../lib/updates"),
			]);
			await maybeSelfInstall();
			// After maybeSelfInstall returns we're either already canonical (normal
			// boot) or this is the relaunched canonical instance after an update
			// took. Either way it's safe to wipe the staging dir + ack marker so a
			// successful update doesn't leave the prior versioned exe lying around.
			cleanupStagingDir();
		}
	} catch (err) {
		writeCrash("prelude", err);
		process.exit(1);
	}
}
