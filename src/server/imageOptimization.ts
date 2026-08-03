import { PNG } from "pngjs";

const MIN_OPTIMIZATION_BYTES = 128 * 1024;
const MAX_OPTIMIZATION_PIXELS = 12_000_000;
const MIN_SAVINGS_BYTES = 4 * 1024;

export type OptimizedImage = {
	buffer: Buffer;
	optimized: boolean;
	originalBytes: number;
};

/**
 * Losslessly recompress managed PNGs while preserving their format and pixel
 * content. JPEG, GIF, and WebP are left untouched to avoid generational loss.
 */
export function optimizeManagedImage(
	buffer: Buffer,
	mime: string,
): OptimizedImage {
	const unchanged = {
		buffer,
		optimized: false,
		originalBytes: buffer.byteLength,
	};
	if (mime !== "image/png" || buffer.byteLength < MIN_OPTIMIZATION_BYTES) {
		return unchanged;
	}
	try {
		const png = PNG.sync.read(buffer);
		if (png.width * png.height > MAX_OPTIMIZATION_PIXELS) return unchanged;
		const optimized = PNG.sync.write(png, {
			deflateLevel: 9,
			deflateStrategy: 3,
			inputHasAlpha: true,
			colorType: 6,
			inputColorType: 6,
			bitDepth: 8,
		});
		if (optimized.byteLength + MIN_SAVINGS_BYTES >= buffer.byteLength) {
			return unchanged;
		}
		return {
			buffer: optimized,
			optimized: true,
			originalBytes: buffer.byteLength,
		};
	} catch {
		// Validation already happens at the storage boundary. If an uncommon PNG
		// encoding cannot be decoded here, preserve its exact original bytes.
		return unchanged;
	}
}
