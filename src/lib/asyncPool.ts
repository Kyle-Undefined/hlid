/** Map items through an async fn with bounded concurrency, preserving order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index] as T, index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}
