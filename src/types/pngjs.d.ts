declare module "pngjs" {
	export type PNGOptions = {
		width?: number;
		height?: number;
		deflateLevel?: number;
		deflateStrategy?: number;
		inputHasAlpha?: boolean;
		colorType?: number;
		inputColorType?: number;
		bitDepth?: number;
	};

	export class PNG {
		constructor(options?: PNGOptions);
		width: number;
		height: number;
		data: Buffer;
		static sync: {
			read(buffer: Buffer, options?: PNGOptions): PNG;
			write(png: PNG, options?: PNGOptions): Buffer;
		};
	}
}
