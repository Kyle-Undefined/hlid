/**
 * Opacity ramp for donut slices. Repo only ships a single `--data` accent var
 * (see src/styles.css), so we vary opacity to get visually distinct slices
 * without inventing new color tokens.
 */
const SLICE_OPACITY = [1, 0.78, 0.6, 0.46, 0.36, 0.28, 0.22, 0.16] as const;

export function sliceOpacity(i: number): number {
	// Defensive: non-integer or negative indices are out-of-contract but still
	// possible (e.g. unfiltered map index). Floor + clamp keeps the lookup safe.
	const idx = Math.max(0, Math.floor(Number.isFinite(i) ? i : 0));
	if (idx < SLICE_OPACITY.length) return SLICE_OPACITY[idx];
	// Beyond the ramp: extrapolate down toward 0.1 floor.
	return Math.max(0.1, 0.16 - (idx - SLICE_OPACITY.length + 1) * 0.02);
}
