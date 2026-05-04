// Flip the PE Windows subsystem from CUI (3) to GUI (2) so Windows does not
// allocate a console window when the exe launches. Bun's --windows-hide-console
// flag is supposed to do this at compile time, but as of bun 1.3.13 it is
// silently ignored — every release exe ships with subsystem=3, which is why
// a blank console window appears on launch. This script patches the byte
// directly, post-build.
//
// PE layout: e_lfanew at offset 0x3C → PE signature → COFF header → optional
// header. Subsystem field sits at peOffset + 0x5C (same offset for PE32 and
// PE32+). Single u16, little-endian. 2 = GUI, 3 = CUI.

import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
	console.error("usage: bun scripts/patch-subsystem.ts <exe>");
	process.exit(1);
}

const buf = readFileSync(path);
if (buf.readUInt16LE(0) !== 0x5a4d) {
	console.error(`${path}: not a PE/MZ file`);
	process.exit(1);
}
const peOffset = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOffset) !== 0x4550) {
	console.error(`${path}: missing PE signature`);
	process.exit(1);
}
const subOffset = peOffset + 0x5c;
const current = buf.readUInt16LE(subOffset);
if (current === 2) {
	console.log(`${path}: already GUI subsystem`);
	process.exit(0);
}
if (current !== 3) {
	console.error(`${path}: unexpected subsystem ${current}, refusing to patch`);
	process.exit(1);
}
buf.writeUInt16LE(2, subOffset);
writeFileSync(path, buf);
console.log(`${path}: patched subsystem 3 -> 2 (GUI)`);
