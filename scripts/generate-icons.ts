import sharp from "sharp";
import { readFileSync } from "fs";
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

// favicon.ico (32x32 PNG works fine as .ico in modern browsers)
await sharp(svg)
	.resize(32, 32)
	.png()
	.toFile(resolve(root, "public/favicon.ico"));
console.log("Generated public/favicon.ico");
