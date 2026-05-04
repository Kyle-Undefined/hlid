// Compiles src/server/index.ts into dist/builds/hlid.exe.
// Mirrors the flags used by .github/workflows/release.yml so a local WSL
// build matches what gets shipped. Run via `bun run build:win`, which first
// runs `bun run build` to produce dist/client + embedded-client.ts.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist", "builds");
mkdirSync(outDir, { recursive: true });

// Windows metadata flags (--windows-hide-console, --windows-icon, etc.) only
// work when bun is running on Windows. From WSL/Linux we cross-compile a working
// exe but skip those flags. CI (.github/workflows/release.yml) runs on Windows
// and applies the full metadata for shipped releases.
const onWindows = process.platform === "win32";

// bun --windows-version requires a 4-part numeric version. Strip any prerelease
// suffix and pad with .0 until we have four segments.
const clean = pkg.version.replace(/-.*$/, "");
const parts = clean.split(".");
while (parts.length < 4) parts.push("0");
const winVersion = parts.slice(0, 4).join(".");

const args = [
	"build",
	"--compile",
	"--target=bun-windows-x64",
	...(onWindows
		? [
				"--windows-hide-console",
				"--windows-icon=public/favicon.ico",
				"--windows-title=Hlid",
				"--windows-publisher=kyleundefined",
				`--windows-version=${winVersion}`,
				"--windows-description=Hlidskjalf - Watcher of Worlds",
			]
		: []),
	`--outfile=${resolve(outDir, "hlid.exe")}`,
	"src/server/index.ts",
];

const proc = Bun.spawn(["bun", ...args], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) process.exit(code);

// bun's --windows-hide-console silently doesn't flip the PE subsystem byte
// (verified empirically: every release exe shipped with subsystem=3/CUI),
// so a blank console window pops on launch. Patch it directly.
const exePath = resolve(outDir, "hlid.exe");
const patch = Bun.spawn(["bun", "scripts/patch-subsystem.ts", exePath], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
});
const patchCode = await patch.exited;
if (patchCode !== 0) process.exit(patchCode);

const meta = onWindows ? `windows-version ${winVersion}` : "no metadata (cross-compile)";
console.log(`Built dist/builds/hlid.exe (${meta})`);
