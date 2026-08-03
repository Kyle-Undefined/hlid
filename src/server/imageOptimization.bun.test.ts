import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { optimizeManagedImage } from "./imageOptimization";

describe("managed image optimization", () => {
	it("losslessly recompresses a large uncompressed PNG", () => {
		const png = new PNG({ width: 512, height: 512 });
		for (let offset = 0; offset < png.data.length; offset += 4) {
			png.data[offset] = 32;
			png.data[offset + 1] = 96;
			png.data[offset + 2] = 160;
			png.data[offset + 3] = 255;
		}
		const source = PNG.sync.write(png, {
			deflateLevel: 0,
			deflateStrategy: 0,
			inputHasAlpha: true,
			colorType: 6,
			inputColorType: 6,
			bitDepth: 8,
		});

		const result = optimizeManagedImage(source, "image/png");

		expect(result.optimized).toBe(true);
		expect(result.buffer.byteLength).toBeLessThan(source.byteLength);
		expect(PNG.sync.read(result.buffer).data).toEqual(
			PNG.sync.read(source).data,
		);
	});

	it("preserves formats that would require lossy re-encoding", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
		expect(optimizeManagedImage(jpeg, "image/jpeg")).toEqual({
			buffer: jpeg,
			optimized: false,
			originalBytes: jpeg.byteLength,
		});
	});
});
