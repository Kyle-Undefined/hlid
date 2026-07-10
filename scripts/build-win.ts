// Compile src/server/index.ts into a Windows executable. The PTY and Whisper
// generators write ignored build artifacts; this build redirects the stable
// development stubs to those generated modules without touching tracked files.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const outfile = resolve(
	root,
	process.env.HLID_BUILD_OUTFILE ?? "dist/builds/hlid.exe",
);
const ptyAssets = resolve(
	root,
	"build/embed-assets/pty/pty-assets.generated.js",
);
const voiceAssets = resolve(
	root,
	"build/embed-assets/whisper/voice-assets.generated.js",
);

for (const generated of [ptyAssets, voiceAssets]) {
	if (!existsSync(generated)) {
		throw new Error(
			`Missing generated asset module ${generated}. Run bun run build:win so the asset generators run first.`,
		);
	}
}
mkdirSync(dirname(outfile), { recursive: true });

const assetRedirectPlugin: BunPlugin = {
	name: "hlid-embedded-runtime-assets",
	setup(build) {
		build.onResolve({ filter: /^\.\/pty-assets$/ }, () => ({
			path: ptyAssets,
		}));
		build.onResolve({ filter: /^\.\/voice-assets$/ }, () => ({
			path: voiceAssets,
		}));
	},
};

const clean = pkg.version.replace(/-.*$/, "");
const parts = clean.split(".");
while (parts.length < 4) parts.push("0");
const winVersion = parts.slice(0, 4).join(".");
const onWindows = process.platform === "win32";

const result = await Bun.build({
	entrypoints: [resolve(root, "src/server/index.ts")],
	plugins: [assetRedirectPlugin],
	compile: {
		target: "bun-windows-x64",
		outfile,
		...(onWindows
			? {
					windows: {
						hideConsole: true,
						icon: resolve(root, "public/favicon.ico"),
						title: "Hlid",
						publisher: "kyleundefined",
						version: winVersion,
						description: "Hlidskjalf - Watcher of Worlds",
					},
				}
			: {}),
	},
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

// Bun's hideConsole option has historically left the PE subsystem as CUI, so
// retain the explicit patch that guarantees a GUI executable.
const patch = Bun.spawn(["bun", "scripts/patch-subsystem.ts", outfile], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
});
const patchCode = await patch.exited;
if (patchCode !== 0) process.exit(patchCode);

const meta = onWindows
	? `windows-version ${winVersion}`
	: "no metadata (cross-compile)";
console.log(`Built ${outfile} (${meta})`);
