import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const svgPath = resolve(root, "public/favicon.svg");
const svg = readFileSync(svgPath);

const sizes: { name: string; size: number }[] = [
	{ name: "logo192.png", size: 192 },
	{ name: "logo512.png", size: 512 },
	{ name: "apple-touch-icon.png", size: 180 },
];

for (const { name, size } of sizes) {
	await sharp(svg)
		.resize(size, size)
		.png()
		.toFile(resolve(root, "public", name));
	console.log(`Generated public/${name}`);
}

// Real multi-resolution .ico for Windows compile (bun --windows-icon).
// Bundle 16/32/48/256, Windows picks the best size per surface.
const icoSizes = [16, 32, 48, 256];
const icoPngs = await Promise.all(
	icoSizes.map((s) => sharp(svg).resize(s, s).png().toBuffer()),
);
const icoBuffer = await pngToIco(icoPngs);
writeFileSync(resolve(root, "public/favicon.ico"), icoBuffer);
console.log("Generated public/favicon.ico");
