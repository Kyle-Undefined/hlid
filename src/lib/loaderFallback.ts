/** Resolve optional loader data quickly without cancelling useful background work. */
export function loaderValueOrFallback<T>(
	read: Promise<T>,
	fallback: T,
	timeoutMs: number,
): Promise<T> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(fallback), timeoutMs);
		void read.then(finish, () => finish(fallback));
	});
}
